-- ============================================
-- Griff Shop Database Schema
-- prefix: griff_
-- ============================================

-- 기존 테이블 삭제 (의존성 순서 역순)
DROP TABLE IF EXISTS griff_payments CASCADE;
DROP TABLE IF EXISTS griff_order_items CASCADE;
DROP TABLE IF EXISTS griff_orders CASCADE;
DROP TABLE IF EXISTS griff_cart_items CASCADE;
DROP TABLE IF EXISTS griff_products CASCADE;
DROP TABLE IF EXISTS griff_categories CASCADE;
DROP TABLE IF EXISTS griff_users CASCADE;

-- ============================================
-- 1. 회원 정보
-- ============================================
CREATE TABLE griff_users (
    id            BIGSERIAL PRIMARY KEY,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    name          VARCHAR(100) NOT NULL,
    phone         VARCHAR(20),
    address       TEXT,
    role          VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_griff_users_email ON griff_users(email);

-- ============================================
-- 2. 상품 카테고리
-- ============================================
CREATE TABLE griff_categories (
    id         BIGSERIAL PRIMARY KEY,
    name       VARCHAR(100) NOT NULL,
    slug       VARCHAR(100) NOT NULL UNIQUE,
    parent_id  BIGINT REFERENCES griff_categories(id) ON DELETE SET NULL,
    sort_order INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_griff_categories_slug ON griff_categories(slug);
CREATE INDEX idx_griff_categories_parent ON griff_categories(parent_id);

-- ============================================
-- 3. 상품 정보
-- ============================================
CREATE TABLE griff_products (
    id          BIGSERIAL PRIMARY KEY,
    category_id BIGINT REFERENCES griff_categories(id) ON DELETE SET NULL,
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    price       INT NOT NULL DEFAULT 0,
    sale_price  INT,
    stock       INT NOT NULL DEFAULT 0,
    thumbnail   TEXT,
    images      JSONB DEFAULT '[]'::jsonb,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_griff_products_category ON griff_products(category_id);
CREATE INDEX idx_griff_products_active ON griff_products(is_active);

-- ============================================
-- 4. 장바구니
-- ============================================
CREATE TABLE griff_cart_items (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES griff_users(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES griff_products(id) ON DELETE CASCADE,
    quantity   INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, product_id)
);

CREATE INDEX idx_griff_cart_items_user ON griff_cart_items(user_id);

-- ============================================
-- 5. 주문
-- ============================================
CREATE TABLE griff_orders (
    id               BIGSERIAL PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES griff_users(id) ON DELETE CASCADE,
    total_amount     INT NOT NULL DEFAULT 0,
    status           VARCHAR(20) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','paid','shipping','delivered','cancelled')),
    shipping_address TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_griff_orders_user ON griff_orders(user_id);
CREATE INDEX idx_griff_orders_status ON griff_orders(status);

-- ============================================
-- 6. 주문 상품
-- ============================================
CREATE TABLE griff_order_items (
    id         BIGSERIAL PRIMARY KEY,
    order_id   BIGINT NOT NULL REFERENCES griff_orders(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES griff_products(id) ON DELETE RESTRICT,
    quantity   INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    price      INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_griff_order_items_order ON griff_order_items(order_id);

-- ============================================
-- 7. 결제 정보
-- ============================================
CREATE TABLE griff_payments (
    id          BIGSERIAL PRIMARY KEY,
    order_id    BIGINT NOT NULL REFERENCES griff_orders(id) ON DELETE CASCADE,
    payment_key VARCHAR(255),
    method      VARCHAR(50),
    status      VARCHAR(20) NOT NULL DEFAULT 'ready'
                CHECK (status IN ('ready','done','cancelled','failed')),
    amount      INT NOT NULL DEFAULT 0,
    approved_at TIMESTAMPTZ
);

CREATE INDEX idx_griff_payments_order ON griff_payments(order_id);
CREATE INDEX idx_griff_payments_key ON griff_payments(payment_key);

-- ============================================
-- updated_at 자동 갱신 트리거 (griff_users)
-- ============================================
CREATE OR REPLACE FUNCTION update_griff_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_griff_users_updated_at
    BEFORE UPDATE ON griff_users
    FOR EACH ROW
    EXECUTE FUNCTION update_griff_updated_at();
