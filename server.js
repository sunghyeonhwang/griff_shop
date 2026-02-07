require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ─── DB 연결 ───────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 5000,
});

// DB 헬퍼 – 라우트에서 pool.query 대신 db.query 로 사용
const db = {
  query: (text, params) => pool.query(text, params),
};

// ─── JWT 설정 ─────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'griff-shop-jwt-secret-change-in-production';
const SALT_ROUNDS = 10;

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role || 'user' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// ─── 인증 미들웨어 ────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '인증 토큰이 필요합니다.' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
  }
}

// ─── 관리자 인증 미들웨어 ─────────────────────────
function adminMiddleware(req, res, next) {
  // authMiddleware가 먼저 실행되어 req.user가 설정된 상태여야 함
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  }
  next();
}

// ─── Express 초기화 ────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 정적 파일 서빙 (React 빌드 등)
app.use(express.static(path.join(__dirname, 'public')));

// ─── 헬스체크 ──────────────────────────────────────
app.get('/api/health', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT NOW() AS now');
    res.json({ status: 'ok', db_time: rows[0].now });
  } catch (err) {
    next(err);
  }
});

// ─── 라우터 ────────────────────────────────────────

// --- /api/auth ---
const authRouter = express.Router();

// 회원가입
authRouter.post('/register', async (req, res, next) => {
  try {
    const { email, password, name, phone } = req.body;

    // 입력 검증
    if (!email || !password || !name) {
      return res.status(400).json({ error: '이메일, 비밀번호, 이름은 필수입니다.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
    }

    // 이메일 중복 체크
    const { rows: existing } = await db.query(
      'SELECT id FROM griff_users WHERE email = $1', [email]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: '이미 등록된 이메일입니다.' });
    }

    // 비밀번호 해싱 후 저장
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await db.query(
      `INSERT INTO griff_users (email, password_hash, name, phone)
       VALUES ($1, $2, $3, $4) RETURNING id, email, name, phone, created_at`,
      [email, passwordHash, name, phone || null]
    );

    const user = rows[0];
    const token = generateToken(user);

    res.status(201).json({
      message: '회원가입 성공',
      user: { id: user.id, email: user.email, name: user.name, phone: user.phone, role: 'user' },
      token,
    });
  } catch (err) { next(err); }
});

// 로그인
authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: '이메일과 비밀번호는 필수입니다.' });
    }

    const { rows } = await db.query(
      'SELECT * FROM griff_users WHERE email = $1', [email]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    }

    const user = rows[0];
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    }

    const token = generateToken(user);

    res.json({
      message: '로그인 성공',
      user: { id: user.id, email: user.email, name: user.name, phone: user.phone, role: user.role || 'user' },
      token,
    });
  } catch (err) { next(err); }
});

// 로그아웃
authRouter.post('/logout', (_req, res) => {
  res.json({ message: '로그아웃 성공. 클라이언트에서 토큰을 삭제하세요.' });
});

// 프로필 조회
authRouter.get('/profile', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, email, name, phone, address, role, created_at, updated_at FROM griff_users WHERE id = $1',
      [req.user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    }
    res.json({ user: rows[0] });
  } catch (err) { next(err); }
});

// 프로필 수정
authRouter.put('/profile', authMiddleware, async (req, res, next) => {
  try {
    const { name, phone, address } = req.body;

    const { rows } = await db.query(
      `UPDATE griff_users
       SET name    = COALESCE($1, name),
           phone   = COALESCE($2, phone),
           address = COALESCE($3, address)
       WHERE id = $4
       RETURNING id, email, name, phone, address, updated_at`,
      [name || null, phone || null, address || null, req.user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    }
    res.json({ message: '프로필 수정 완료', user: rows[0] });
  } catch (err) { next(err); }
});

app.use('/api/auth', authRouter);

// --- /api/categories ---
const categoriesRouter = express.Router();

// 카테고리 목록 (계층 구조 포함)
categoriesRouter.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM griff_products p
               WHERE p.category_id = c.id AND p.is_active = true) AS product_count
       FROM griff_categories c
       ORDER BY c.sort_order ASC, c.id ASC`
    );

    // 계층 구조로 변환 (parent_id 기반 트리)
    const map = {};
    const roots = [];
    for (const cat of rows) {
      cat.children = [];
      map[cat.id] = cat;
    }
    for (const cat of rows) {
      if (cat.parent_id && map[cat.parent_id]) {
        map[cat.parent_id].children.push(cat);
      } else {
        roots.push(cat);
      }
    }

    res.json({ categories: roots, flat: rows });
  } catch (err) { next(err); }
});

app.use('/api/categories', categoriesRouter);

// --- /api/products ---
const productsRouter = express.Router();

// 상품 목록 (카테고리 필터, 페이지네이션, 정렬, 검색)
productsRouter.get('/', async (req, res, next) => {
  try {
    const {
      category,     // 카테고리 slug 또는 id
      page = 1,
      limit = 20,
      sort = 'newest',  // newest, price_asc, price_desc, name
      search,
      min_price,
      max_price,
      exclude_sold_out,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    // 동적 WHERE 조건 생성
    const conditions = ['p.is_active = true'];
    const params = [];
    let paramIdx = 1;

    // 카테고리 필터 (slug 또는 id)
    if (category) {
      // 해당 카테고리 + 하위 카테고리까지 포함
      conditions.push(
        `p.category_id IN (
           SELECT id FROM griff_categories
           WHERE slug = $${paramIdx}
              OR id::text = $${paramIdx}
              OR parent_id = (SELECT id FROM griff_categories WHERE slug = $${paramIdx} LIMIT 1)
         )`
      );
      params.push(category);
      paramIdx++;
    }

    // 검색
    if (search) {
      conditions.push(`(p.name ILIKE $${paramIdx} OR p.description ILIKE $${paramIdx})`);
      params.push(`%${search}%`);
      paramIdx++;
    }

    // 가격 범위
    if (min_price) {
      conditions.push(`COALESCE(p.sale_price, p.price) >= $${paramIdx}`);
      params.push(parseInt(min_price, 10));
      paramIdx++;
    }
    if (max_price) {
      conditions.push(`COALESCE(p.sale_price, p.price) <= $${paramIdx}`);
      params.push(parseInt(max_price, 10));
      paramIdx++;
    }

    // 품절 제외
    if (exclude_sold_out === 'true') {
      conditions.push('p.stock > 0');
    }

    // 정렬
    const sortMap = {
      newest: 'p.created_at DESC',
      price_asc: 'COALESCE(p.sale_price, p.price) ASC',
      price_desc: 'COALESCE(p.sale_price, p.price) DESC',
      name: 'p.name ASC',
    };
    const orderBy = sortMap[sort] || sortMap.newest;

    const whereClause = conditions.join(' AND ');

    // 전체 개수 조회
    const countResult = await db.query(
      `SELECT COUNT(*) FROM griff_products p WHERE ${whereClause}`,
      params
    );
    const totalCount = parseInt(countResult.rows[0].count, 10);
    const totalPages = Math.ceil(totalCount / limitNum);

    // 상품 목록 조회 (카테고리 정보 JOIN)
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.price, p.sale_price, p.stock, p.thumbnail, p.is_active, p.created_at,
              c.id AS category_id, c.name AS category_name, c.slug AS category_slug
       FROM griff_products p
       LEFT JOIN griff_categories c ON c.id = p.category_id
       WHERE ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limitNum, offset]
    );

    res.json({
      products: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total_count: totalCount,
        total_pages: totalPages,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1,
      },
    });
  } catch (err) { next(err); }
});

// 상품 상세 (카테고리 정보 포함)
productsRouter.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*,
              c.id AS category_id, c.name AS category_name, c.slug AS category_slug
       FROM griff_products p
       LEFT JOIN griff_categories c ON c.id = p.category_id
       WHERE p.id = $1 AND p.is_active = true`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
    }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.use('/api/products', productsRouter);

// --- /api/cart --- (모든 엔드포인트 JWT 인증 필수)
const cartRouter = express.Router();
cartRouter.use(authMiddleware);

// GET /api/cart – 내 장바구니 목록 조회 (상품 정보 포함)
cartRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ci.id, ci.quantity, ci.created_at,
              p.id AS product_id, p.name, p.price, p.sale_price,
              p.stock, p.thumbnail, p.is_active
       FROM griff_cart_items ci
       JOIN griff_products p ON p.id = ci.product_id
       WHERE ci.user_id = $1
       ORDER BY ci.created_at DESC`,
      [req.user.id]
    );

    const totalPrice = rows.reduce((sum, item) => {
      const unitPrice = item.sale_price ?? item.price;
      return sum + unitPrice * item.quantity;
    }, 0);

    res.json({ items: rows, total_price: totalPrice, count: rows.length });
  } catch (err) { next(err); }
});

// POST /api/cart – 장바구니에 상품 추가
cartRouter.post('/', async (req, res, next) => {
  try {
    const { product_id, quantity } = req.body;

    if (!product_id) {
      return res.status(400).json({ error: 'product_id는 필수입니다.' });
    }
    const qty = Math.max(1, parseInt(quantity, 10) || 1);

    // 상품 존재 + 활성 + 재고 확인
    const { rows: products } = await db.query(
      'SELECT id, stock, is_active FROM griff_products WHERE id = $1',
      [product_id]
    );
    if (products.length === 0 || !products[0].is_active) {
      return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
    }

    // 기존 장바구니 수량 확인하여 총 수량이 재고를 초과하지 않도록 검증
    const { rows: existingCart } = await db.query(
      'SELECT quantity FROM griff_cart_items WHERE user_id = $1 AND product_id = $2',
      [req.user.id, product_id]
    );
    const currentQty = existingCart.length > 0 ? existingCart[0].quantity : 0;
    if (currentQty + qty > products[0].stock) {
      return res.status(400).json({
        error: `재고가 부족합니다. (재고: ${products[0].stock}, 장바구니: ${currentQty}, 요청: ${qty})`
      });
    }

    const { rows } = await db.query(
      `INSERT INTO griff_cart_items (user_id, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, product_id)
       DO UPDATE SET quantity = griff_cart_items.quantity + EXCLUDED.quantity
       RETURNING *`,
      [req.user.id, product_id, qty]
    );

    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/cart/:id – 수량 변경
cartRouter.put('/:id', async (req, res, next) => {
  try {
    const { quantity } = req.body;

    if (quantity == null || parseInt(quantity, 10) < 1) {
      return res.status(400).json({ error: '수량은 1 이상이어야 합니다.' });
    }
    const qty = parseInt(quantity, 10);

    // 본인 장바구니 항목인지 확인 + 재고 체크
    const { rows: items } = await db.query(
      `SELECT ci.id, ci.product_id, p.stock
       FROM griff_cart_items ci
       JOIN griff_products p ON p.id = ci.product_id
       WHERE ci.id = $1 AND ci.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (items.length === 0) {
      return res.status(404).json({ error: '장바구니 항목을 찾을 수 없습니다.' });
    }
    if (items[0].stock < qty) {
      return res.status(400).json({ error: '재고가 부족합니다.' });
    }

    const { rows } = await db.query(
      'UPDATE griff_cart_items SET quantity = $1 WHERE id = $2 RETURNING *',
      [qty, req.params.id]
    );

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/cart/:id – 장바구니에서 개별 삭제
cartRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM griff_cart_items WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: '장바구니 항목을 찾을 수 없습니다.' });
    }
    res.json({ message: '삭제 완료' });
  } catch (err) { next(err); }
});

// DELETE /api/cart – 장바구니 비우기
cartRouter.delete('/', async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM griff_cart_items WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ message: '장바구니 비우기 완료', deleted_count: rowCount });
  } catch (err) { next(err); }
});

app.use('/api/cart', cartRouter);

// --- /api/orders --- (모든 엔드포인트 JWT 인증 필수)
const ordersRouter = express.Router();
ordersRouter.use(authMiddleware);

// GET /api/orders – 내 주문 목록 조회
ordersRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT o.id, o.total_amount, o.status, o.shipping_address, o.created_at,
              COUNT(oi.id)::int AS item_count
       FROM griff_orders o
       LEFT JOIN griff_order_items oi ON oi.order_id = o.id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json({ orders: rows });
  } catch (err) { next(err); }
});

// GET /api/orders/:id – 주문 상세 조회 (주문 상품 + 상품 정보 포함)
ordersRouter.get('/:id', async (req, res, next) => {
  try {
    const { rows: orders } = await db.query(
      'SELECT * FROM griff_orders WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (orders.length === 0) {
      return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });
    }

    const { rows: items } = await db.query(
      `SELECT oi.id, oi.product_id, oi.quantity, oi.price,
              p.name, p.thumbnail
       FROM griff_order_items oi
       JOIN griff_products p ON p.id = oi.product_id
       WHERE oi.order_id = $1`,
      [req.params.id]
    );

    res.json({ order: { ...orders[0], items } });
  } catch (err) { next(err); }
});

// POST /api/orders – 주문 생성 (장바구니 → 주문 전환, 재고 차감)
ordersRouter.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { shipping_address } = req.body;
    const userId = req.user.id;

    // 1) 장바구니 조회 (상품 정보 + 재고 JOIN)
    const { rows: cartItems } = await client.query(
      `SELECT ci.id AS cart_id, ci.product_id, ci.quantity,
              p.name, p.price, p.sale_price, p.stock, p.is_active
       FROM griff_cart_items ci
       JOIN griff_products p ON p.id = ci.product_id
       WHERE ci.user_id = $1
       FOR UPDATE OF p`,
      [userId]
    );

    if (cartItems.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '장바구니가 비어 있습니다.' });
    }

    // 2) 재고 · 활성 상태 검증
    for (const item of cartItems) {
      if (!item.is_active) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `"${item.name}" 상품은 현재 판매 중지 상태입니다.` });
      }
      if (item.stock < item.quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `"${item.name}" 재고가 부족합니다. (재고: ${item.stock}, 요청: ${item.quantity})` });
      }
    }

    // 3) 총 금액 계산
    const totalAmount = cartItems.reduce((sum, item) => {
      const unitPrice = item.sale_price ?? item.price;
      return sum + unitPrice * item.quantity;
    }, 0);

    // 4) 주문 생성
    const { rows: [order] } = await client.query(
      `INSERT INTO griff_orders (user_id, total_amount, status, shipping_address)
       VALUES ($1, $2, 'pending', $3) RETURNING *`,
      [userId, totalAmount, shipping_address || null]
    );

    // 5) 주문 상품 추가 + 재고 차감
    for (const item of cartItems) {
      const unitPrice = item.sale_price ?? item.price;
      await client.query(
        `INSERT INTO griff_order_items (order_id, product_id, quantity, price)
         VALUES ($1, $2, $3, $4)`,
        [order.id, item.product_id, item.quantity, unitPrice]
      );
      await client.query(
        'UPDATE griff_products SET stock = stock - $1 WHERE id = $2',
        [item.quantity, item.product_id]
      );
    }

    // 6) 장바구니 비우기
    await client.query('DELETE FROM griff_cart_items WHERE user_id = $1', [userId]);

    await client.query('COMMIT');

    res.status(201).json({
      message: '주문이 생성되었습니다.',
      order: { ...order, items: cartItems.map(ci => ({
        product_id: ci.product_id,
        name: ci.name,
        quantity: ci.quantity,
        price: ci.sale_price ?? ci.price,
      })) },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/orders/:id/cancel – 결제 실패/취소 시 주문 롤백 (pending 상태만)
ordersRouter.post('/:id/cancel', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: orders } = await client.query(
      'SELECT id, user_id, status FROM griff_orders WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );

    if (orders.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });
    }

    const order = orders[0];

    if (Number(order.user_id) !== Number(req.user.id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '권한이 없습니다.' });
    }

    if (order.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'pending 상태의 주문만 취소할 수 있습니다.' });
    }

    // 재고 복원
    const { rows: items } = await client.query(
      'SELECT product_id, quantity FROM griff_order_items WHERE order_id = $1',
      [req.params.id]
    );
    for (const item of items) {
      await client.query(
        'UPDATE griff_products SET stock = stock + $1 WHERE id = $2',
        [item.quantity, item.product_id]
      );
    }

    // 장바구니 아이템 복원
    for (const item of items) {
      // 이미 장바구니에 같은 상품이 있으면 수량 증가, 없으면 새로 추가
      const { rows: existing } = await client.query(
        'SELECT id, quantity FROM griff_cart_items WHERE user_id = $1 AND product_id = $2',
        [order.user_id, item.product_id]
      );
      if (existing.length > 0) {
        await client.query(
          'UPDATE griff_cart_items SET quantity = quantity + $1 WHERE id = $2',
          [item.quantity, existing[0].id]
        );
      } else {
        await client.query(
          'INSERT INTO griff_cart_items (user_id, product_id, quantity) VALUES ($1, $2, $3)',
          [order.user_id, item.product_id, item.quantity]
        );
      }
    }

    // 주문 상태를 cancelled로 변경
    await client.query(
      "UPDATE griff_orders SET status = 'cancelled' WHERE id = $1",
      [req.params.id]
    );

    await client.query('COMMIT');

    res.json({ message: '주문이 취소되었습니다.' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

app.use('/api/orders', ordersRouter);

// --- /api/payments (토스페이먼츠 연동) ---
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY;
const TOSS_API_URL = 'https://api.tosspayments.com/v1/payments';

const paymentsRouter = express.Router();

// POST /api/payments/confirm – 토스페이먼츠 결제 승인
paymentsRouter.post('/confirm', authMiddleware, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { paymentKey, orderId, amount } = req.body;

    if (!paymentKey || !orderId || amount == null) {
      return res.status(400).json({ error: 'paymentKey, orderId, amount는 필수입니다.' });
    }

    await client.query('BEGIN');

    // 1) DB에서 주문 조회 + 금액 검증 + 소유자 확인
    const { rows: orders } = await client.query(
      'SELECT id, user_id, total_amount, status FROM griff_orders WHERE id = $1 FOR UPDATE',
      [orderId]
    );

    if (orders.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });
    }

    const order = orders[0];

    // 주문 소유자 확인 (DB의 BIGSERIAL은 문자열로 반환될 수 있으므로 Number 변환)
    if (Number(order.user_id) !== Number(req.user.id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '권한이 없습니다.' });
    }

    if (order.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `이미 처리된 주문입니다. (상태: ${order.status})` });
    }

    if (Number(order.total_amount) !== Number(amount)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '결제 금액이 주문 금액과 일치하지 않습니다.' });
    }

    // 2) 토스페이먼츠 결제 승인 API 호출
    if (!TOSS_SECRET_KEY) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: '결제 서비스가 설정되지 않았습니다.' });
    }
    const encodedKey = Buffer.from(TOSS_SECRET_KEY + ':').toString('base64');
    const tossResponse = await fetch(`${TOSS_API_URL}/confirm`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${encodedKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId: String(orderId), amount: Number(amount) }),
    });

    const tossData = await tossResponse.json();

    if (!tossResponse.ok) {
      await client.query('ROLLBACK');
      return res.status(tossResponse.status).json({
        error: '결제 승인 실패',
        code: tossData.code,
        message: tossData.message,
      });
    }

    // 3) 결제 정보 저장
    const { rows: payments } = await client.query(
      `INSERT INTO griff_payments (order_id, payment_key, method, amount, status, approved_at)
       VALUES ($1, $2, $3, $4, 'done', $5) RETURNING *`,
      [orderId, paymentKey, tossData.method, Number(amount), tossData.approvedAt]
    );

    // 4) 주문 상태 업데이트
    await client.query(
      "UPDATE griff_orders SET status = 'paid' WHERE id = $1",
      [orderId]
    );

    await client.query('COMMIT');

    res.json({
      message: '결제 승인 완료',
      payment: payments[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/payments/webhook – 토스페이먼츠 웹훅 수신
paymentsRouter.post('/webhook', async (req, res, next) => {
  try {
    const { eventType, data } = req.body;

    if (eventType === 'PAYMENT_STATUS_CHANGED') {
      const { paymentKey, status, orderId } = data;

      // 웹훅으로 전달된 상태에 따라 DB 업데이트
      const statusMap = {
        DONE: 'done',
        CANCELED: 'cancelled',
        PARTIAL_CANCELED: 'cancelled',
        ABORTED: 'failed',
        EXPIRED: 'failed',
      };

      const dbStatus = statusMap[status];
      if (!dbStatus) {
        return res.json({ success: true }); // 알 수 없는 상태는 무시
      }

      // 결제 상태 업데이트
      await db.query(
        'UPDATE griff_payments SET status = $1 WHERE payment_key = $2',
        [dbStatus, paymentKey]
      );

      // 주문 상태 동기화
      const orderStatusMap = {
        done: 'paid',
        cancelled: 'cancelled',
        failed: 'cancelled',
      };

      if (orderId && orderStatusMap[dbStatus]) {
        await db.query(
          'UPDATE griff_orders SET status = $1 WHERE id = $2',
          [orderStatusMap[dbStatus], orderId]
        );
      }
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/payments/:orderId – 결제 정보 조회
paymentsRouter.get('/:orderId', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT p.* FROM griff_payments p
       JOIN griff_orders o ON o.id = p.order_id
       WHERE p.order_id = $1 AND o.user_id = $2`,
      [req.params.orderId, req.user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: '결제 정보를 찾을 수 없습니다.' });
    }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.use('/api/payments', paymentsRouter);

// --- /api/admin --- (관리자 전용, JWT + role=admin 필수)
const adminRouter = express.Router();
adminRouter.use(authMiddleware);
adminRouter.use(adminMiddleware);

// ── 대시보드 통계 ──────────────────────────────────
adminRouter.get('/stats', async (_req, res, next) => {
  try {
    const [ordersResult, revenueResult, usersResult, productsResult, recentOrdersResult] = await Promise.all([
      db.query('SELECT COUNT(*)::int AS count FROM griff_orders'),
      db.query("SELECT COALESCE(SUM(total_amount), 0)::int AS revenue FROM griff_orders WHERE status IN ('paid','shipping','delivered')"),
      db.query('SELECT COUNT(*)::int AS count FROM griff_users'),
      db.query('SELECT COUNT(*)::int AS count FROM griff_products WHERE is_active = true'),
      db.query(`SELECT status, COUNT(*)::int AS count FROM griff_orders GROUP BY status`),
    ]);

    res.json({
      total_orders: ordersResult.rows[0].count,
      total_revenue: revenueResult.rows[0].revenue,
      total_users: usersResult.rows[0].count,
      active_products: productsResult.rows[0].count,
      orders_by_status: recentOrdersResult.rows.reduce((acc, r) => { acc[r.status] = r.count; return acc; }, {}),
    });
  } catch (err) { next(err); }
});

// ── 상품 관리 ──────────────────────────────────────

// GET /api/admin/products – 관리자 상품 목록 (is_active 포함 전체)
adminRouter.get('/products', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*, c.name AS category_name
       FROM griff_products p
       LEFT JOIN griff_categories c ON p.category_id = c.id
       ORDER BY p.created_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/admin/products – 상품 등록
adminRouter.post('/products', async (req, res, next) => {
  try {
    const { category_id, name, description, price, sale_price, stock, thumbnail, images, is_active } = req.body;

    if (!name || price == null) {
      return res.status(400).json({ error: '상품명과 가격은 필수입니다.' });
    }

    const { rows } = await db.query(
      `INSERT INTO griff_products (category_id, name, description, price, sale_price, stock, thumbnail, images, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        category_id || null,
        name,
        description || null,
        parseInt(price, 10),
        sale_price != null ? parseInt(sale_price, 10) : null,
        parseInt(stock, 10) || 0,
        thumbnail || null,
        JSON.stringify(images || []),
        is_active !== false,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/admin/products/:id – 상품 수정
adminRouter.put('/products/:id', async (req, res, next) => {
  try {
    const { category_id, name, description, price, sale_price, stock, thumbnail, images, is_active } = req.body;

    const { rows } = await db.query(
      `UPDATE griff_products
       SET category_id = COALESCE($1, category_id),
           name        = COALESCE($2, name),
           description = COALESCE($3, description),
           price       = COALESCE($4, price),
           sale_price  = $5,
           stock       = COALESCE($6, stock),
           thumbnail   = COALESCE($7, thumbnail),
           images      = COALESCE($8, images),
           is_active   = COALESCE($9, is_active)
       WHERE id = $10
       RETURNING *`,
      [
        category_id !== undefined ? category_id : null,
        name || null,
        description !== undefined ? description : null,
        price != null ? parseInt(price, 10) : null,
        sale_price != null ? parseInt(sale_price, 10) : null,
        stock != null ? parseInt(stock, 10) : null,
        thumbnail !== undefined ? thumbnail : null,
        images !== undefined ? JSON.stringify(images) : null,
        is_active !== undefined ? is_active : null,
        req.params.id,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
    }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/admin/products/:id – 상품 삭제 (소프트 삭제: is_active=false)
adminRouter.delete('/products/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'UPDATE griff_products SET is_active = false WHERE id = $1 RETURNING id, name, is_active',
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
    }
    res.json({ message: '상품이 비활성화되었습니다.', product: rows[0] });
  } catch (err) { next(err); }
});

// ── 카테고리 관리 ──────────────────────────────────

// POST /api/admin/categories – 카테고리 등록
adminRouter.post('/categories', async (req, res, next) => {
  try {
    const { name, slug, parent_id, sort_order } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ error: '카테고리명과 slug는 필수입니다.' });
    }

    const { rows } = await db.query(
      `INSERT INTO griff_categories (name, slug, parent_id, sort_order)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, slug, parent_id || null, parseInt(sort_order, 10) || 0]
    );

    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/admin/categories/:id – 카테고리 수정
adminRouter.put('/categories/:id', async (req, res, next) => {
  try {
    const { name, slug, parent_id, sort_order } = req.body;

    const { rows } = await db.query(
      `UPDATE griff_categories
       SET name       = COALESCE($1, name),
           slug       = COALESCE($2, slug),
           parent_id  = $3,
           sort_order = COALESCE($4, sort_order)
       WHERE id = $5
       RETURNING *`,
      [
        name || null,
        slug || null,
        parent_id !== undefined ? (parent_id || null) : null,
        sort_order != null ? parseInt(sort_order, 10) : null,
        req.params.id,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: '카테고리를 찾을 수 없습니다.' });
    }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/admin/categories/:id – 카테고리 삭제
adminRouter.delete('/categories/:id', async (req, res, next) => {
  try {
    // 하위 카테고리가 있으면 삭제 불가
    const { rows: children } = await db.query(
      'SELECT id FROM griff_categories WHERE parent_id = $1 LIMIT 1',
      [req.params.id]
    );
    if (children.length > 0) {
      return res.status(400).json({ error: '하위 카테고리가 있어 삭제할 수 없습니다. 하위 카테고리를 먼저 삭제하세요.' });
    }

    // 해당 카테고리를 사용하는 상품은 category_id = null 로 변경
    await db.query(
      'UPDATE griff_products SET category_id = NULL WHERE category_id = $1',
      [req.params.id]
    );

    const { rowCount } = await db.query(
      'DELETE FROM griff_categories WHERE id = $1',
      [req.params.id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: '카테고리를 찾을 수 없습니다.' });
    }
    res.json({ message: '카테고리가 삭제되었습니다.' });
  } catch (err) { next(err); }
});

// ── 주문 관리 ──────────────────────────────────────

// GET /api/admin/orders – 전체 주문 목록 (필터, 페이지네이션)
adminRouter.get('/orders', async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (status) {
      conditions.push(`o.status = $${paramIdx}`);
      params.push(status);
      paramIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS count FROM griff_orders o ${whereClause}`,
      params
    );
    const totalCount = countResult.rows[0].count;

    const { rows } = await db.query(
      `SELECT o.id, o.user_id, o.total_amount, o.status, o.shipping_address, o.created_at,
              u.name AS user_name, u.email AS user_email,
              COUNT(oi.id)::int AS item_count
       FROM griff_orders o
       LEFT JOIN griff_users u ON u.id = o.user_id
       LEFT JOIN griff_order_items oi ON oi.order_id = o.id
       ${whereClause}
       GROUP BY o.id, u.name, u.email
       ORDER BY o.created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limitNum, offset]
    );

    res.json({
      orders: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total_count: totalCount,
        total_pages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/orders/:id – 주문 상세 조회
adminRouter.get('/orders/:id', async (req, res, next) => {
  try {
    const { rows: orders } = await db.query(
      `SELECT o.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone
       FROM griff_orders o
       LEFT JOIN griff_users u ON u.id = o.user_id
       WHERE o.id = $1`,
      [req.params.id]
    );
    if (orders.length === 0) {
      return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });
    }

    const { rows: items } = await db.query(
      `SELECT oi.id, oi.product_id, oi.quantity, oi.price,
              p.name, p.thumbnail
       FROM griff_order_items oi
       JOIN griff_products p ON p.id = oi.product_id
       WHERE oi.order_id = $1`,
      [req.params.id]
    );

    const { rows: payments } = await db.query(
      'SELECT * FROM griff_payments WHERE order_id = $1',
      [req.params.id]
    );

    res.json({ order: { ...orders[0], items, payments } });
  } catch (err) { next(err); }
});

// PUT /api/admin/orders/:id/status – 주문 상태 변경
adminRouter.put('/orders/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    const validStatuses = ['pending', 'paid', 'shipping', 'delivered', 'cancelled'];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `유효하지 않은 상태입니다. (${validStatuses.join(', ')})` });
    }

    // 현재 주문 조회
    const { rows: orders } = await db.query(
      'SELECT id, status FROM griff_orders WHERE id = $1',
      [req.params.id]
    );
    if (orders.length === 0) {
      return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });
    }

    const currentStatus = orders[0].status;

    // 상태 전이 규칙: pending→paid→shipping→delivered, 어디서든→cancelled
    const transitions = {
      pending:   ['paid', 'cancelled'],
      paid:      ['shipping', 'cancelled'],
      shipping:  ['delivered', 'cancelled'],
      delivered: [],
      cancelled: [],
    };

    if (!transitions[currentStatus].includes(status)) {
      return res.status(400).json({
        error: `${currentStatus} → ${status} 상태 전환은 허용되지 않습니다.`,
        allowed: transitions[currentStatus],
      });
    }

    // 취소 시 재고 복원
    if (status === 'cancelled') {
      const { rows: items } = await db.query(
        'SELECT product_id, quantity FROM griff_order_items WHERE order_id = $1',
        [req.params.id]
      );
      for (const item of items) {
        await db.query(
          'UPDATE griff_products SET stock = stock + $1 WHERE id = $2',
          [item.quantity, item.product_id]
        );
      }
    }

    const { rows } = await db.query(
      'UPDATE griff_orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );

    res.json({ message: '주문 상태가 변경되었습니다.', order: rows[0] });
  } catch (err) { next(err); }
});

app.use('/api/admin', adminRouter);

// ─── React SPA 폴백 ───────────────────────────────
app.get('{*path}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── 에러 핸들링 미들웨어 ──────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({
    message: err.message || '서버 내부 오류',
  });
});

// ─── 서버 시작 ─────────────────────────────────────
const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`);
});

module.exports = app;
