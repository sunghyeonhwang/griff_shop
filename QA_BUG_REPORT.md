# GRIFF Shop 관리자 페이지 QA 버그 리포트

**테스트 일시**: 2026-02-08
**테스터**: QA Agent
**테스트 범위**: 관리자(Admin) 페이지 전체 (대시보드, 상품 관리, 주문 관리, 카테고리 관리, 인증/권한)

---

## CRITICAL 버그 (즉시 수정 필요)

### BUG-001: 음수 가격/재고 상품 등록 가능
- **심각도**: CRITICAL
- **위치**: `server.js:913-940` (`POST /api/admin/products`)
- **증상**: 가격에 음수(-1000), 재고에 음수(-10) 값을 전달해도 상품이 정상 등록됨
- **재현**: `POST /api/admin/products {"name":"test", "price":-1000, "stock":-10}`
- **기대 동작**: 가격 0 미만, 재고 0 미만은 400 에러 반환
- **영향**: 결제 금액 오류, 재고 관리 오류 발생 가능

### BUG-002: 할인가가 정가보다 높아도 등록 가능
- **심각도**: CRITICAL
- **위치**: `server.js:913-940` (`POST /api/admin/products`)
- **증상**: price=10,000, sale_price=50,000 으로 등록 가능
- **재현**: `POST /api/admin/products {"name":"test", "price":10000, "sale_price":50000}`
- **기대 동작**: sale_price > price 인 경우 400 에러 반환
- **영향**: 고객에게 잘못된 할인 정보 표시, 실제 결제 금액 오류

### BUG-003: 상품 수정 시 sale_price가 null로 리셋됨
- **심각도**: CRITICAL
- **위치**: `server.js:943-979` (`PUT /api/admin/products/:id`)
- **증상**: 상품 이름만 변경해도 sale_price가 null로 초기화됨
- **원인**: `sale_price = $5`로 직접 할당 (COALESCE 미사용). sale_price를 보내지 않으면 `req.body.sale_price`가 undefined → `parseInt(undefined, 10)`은 NaN → `null`로 처리됨
- **재현**: `PUT /api/admin/products/1 {"name":"리빙쉘 롱 Pro."}` → sale_price가 1,780,000원에서 null로 변경
- **기대 동작**: sale_price를 전달하지 않으면 기존 값 유지
- **영향**: 관리자가 다른 필드만 수정해도 할인가가 사라져 고객 혼란 및 매출 손실

### BUG-004: 카테고리 수정 시 parent_id가 null로 리셋됨
- **심각도**: CRITICAL
- **위치**: `server.js:1018-1044` (`PUT /api/admin/categories/:id`)
- **증상**: 카테고리 이름만 변경해도 parent_id가 null로 초기화됨
- **원인**: `parent_id = $3`로 직접 할당. JSON 요청에 parent_id 필드 없으면 undefined → `(undefined !== undefined ? ... : null)` → null
- **재현**: 하위 카테고리(parent_id=1) 생성 후, `PUT /api/admin/categories/:id {"name":"new name"}` → parent_id가 null로 변경
- **기대 동작**: parent_id를 전달하지 않으면 기존 값 유지
- **영향**: 카테고리 계층 구조가 깨지며, 하위 카테고리가 최상위로 이동

### BUG-005: 주문 관리 페이지네이션이 동작하지 않음
- **심각도**: CRITICAL
- **위치**: `public/index.html:3476`
- **증상**: 주문 수가 20개를 초과해도 페이지네이션 버튼이 표시되지 않음
- **원인**: `setTotal(data.total || 0)` — API 응답에 `data.total` 필드가 없음. 실제 응답은 `data.pagination.total_count`
- **수정 필요**: `data.total` → `data.pagination?.total_count`
- **영향**: 모든 주문이 첫 페이지에만 표시되거나, 20개 초과 주문은 접근 불가

---

## HIGH 버그

### BUG-006: 주문 상태 변경 드롭다운에 불가능한 전이 옵션 표시
- **심각도**: HIGH (UX)
- **위치**: `public/index.html:3570-3578`
- **증상**: cancelled/delivered 상태 주문에도 모든 상태 옵션(결제대기, 결제완료 등)이 드롭다운에 표시됨
- **현상**: 사용자가 선택하면 백엔드에서 400 에러 발생, 에러 토스트만 표시
- **기대 동작**: 현재 상태에서 전이 가능한 옵션만 드롭다운에 표시 (예: pending → [paid, cancelled])
- **영향**: 관리자 혼란, 불필요한 에러 발생, 불가능한 작업 시도

### BUG-007: 관리자 주문 취소 시 트랜잭션 미사용
- **심각도**: HIGH
- **위치**: `server.js:1162-1219` (`PUT /api/admin/orders/:id/status`)
- **증상**: 주문 취소 시 재고 복원을 `db.query`로 수행 (Pool 직접 사용)
- **원인**: 사용자의 주문 취소(`POST /api/orders/:id/cancel`)는 트랜잭션 사용하지만, 관리자의 주문 상태 변경은 트랜잭션 없이 개별 쿼리 실행
- **영향**: 재고 복원 도중 에러 발생 시 일부 상품만 재고 복원되어 데이터 불일치

### BUG-008: 모바일에서 관리자 페이지 컨텐츠가 보이지 않음
- **심각도**: HIGH (UI)
- **위치**: `public/index.html:3094-3138` (AdminLayout)
- **증상**: 375px 너비에서 대시보드, 주문 관리 등의 실제 컨텐츠가 뷰포트 밖으로 밀림
- **원인**: `flex gap-6` 컨테이너 안에 모바일 탭(`w-full`)과 컨텐츠 영역이 나란히 있음. 모바일에서 사이드바가 hidden되면 탭이 w-full을 차지하여 flex-1 컨텐츠가 오른쪽으로 밀려남
- **수정 필요**: flex 방향을 모바일에서 column으로 변경하거나, 모바일 탭을 flex 컨테이너 밖으로 이동
- **스크린샷**: `qa-admin-mobile-dashboard.png`, `qa-admin-mobile-orders.png`

### BUG-009: 카테고리 중복 slug 등록 시 raw DB 에러 노출
- **심각도**: HIGH
- **위치**: `server.js:998-1015` (`POST /api/admin/categories`)
- **증상**: 중복 slug로 카테고리 등록 시 `duplicate key value violates unique constraint "griff_categories_slug_key"` DB 에러가 그대로 클라이언트에 노출
- **기대 동작**: "이미 사용 중인 slug입니다"와 같은 사용자 친화적 에러 메시지 반환
- **영향**: 내부 DB 구조 정보 노출, 사용자 혼란

---

## MEDIUM 버그

### BUG-010: sale_price가 0인 상품 등록 가능
- **심각도**: MEDIUM
- **위치**: `server.js:913-940`
- **증상**: sale_price=0으로 등록하면 "무료" 상품이 되어버림
- **기대 동작**: sale_price가 0이면 null 또는 에러 처리
- **영향**: 실수로 0원 할인가 설정 시 무료 판매 가능

### BUG-011: 에러 핸들러에서 `error` 필드 대신 `message` 필드 사용
- **심각도**: MEDIUM
- **위치**: `server.js:1229-1234`
- **증상**: 전역 에러 핸들러가 `{ message: err.message }` 형태로 응답하지만, 프론트엔드의 `apiFetch`는 `data.error || data.message`를 순서대로 확인
- **영향**: 일부 에러 케이스(카테고리 중복 slug 등)에서 에러 메시지가 제대로 표시되지 않을 수 있음

### BUG-012: 대시보드 활성 상품 수 vs 상품 관리 목록 불일치 (필터 부재)
- **심각도**: MEDIUM (UX)
- **위치**: `public/index.html:3218-3361`
- **증상**: 대시보드에는 "활성 상품: 9개"로 표시되지만, 상품 관리 목록에는 비활성 상품 포함 16개가 모두 표시됨. 활성/비활성 필터가 없음
- **기대 동작**: 상품 관리에서 활성/비활성 필터 또는 정렬 기능 제공

---

## LOW 버그 / 개선 사항

### BUG-013: 상품 설명에 HTML/Script 삽입 가능 (잠재적 XSS)
- **심각도**: LOW (React가 기본 이스케이프 처리)
- **위치**: `server.js:913-940`
- **증상**: 상품 설명에 `<script>alert("XSS")</script>` 삽입 가능
- **현재 상태**: React의 기본 이스케이프로 브라우저에서 실행되지 않지만, `dangerouslySetInnerHTML` 사용 시 취약해질 수 있음
- **권장**: 서버사이드에서 HTML 태그 필터링 추가

### BUG-014: 관리자 API에 Rate Limiting 없음
- **심각도**: LOW
- **위치**: 전체 Express 앱
- **증상**: 관리자 API에 요청 속도 제한이 없음
- **영향**: 자동화 공격에 의한 대량 데이터 생성/수정 가능

### BUG-015: JWT Secret이 하드코딩됨
- **심각도**: LOW (환경변수로 오버라이드 가능)
- **위치**: `server.js:23`
- **증상**: `JWT_SECRET` 기본값이 코드에 하드코딩. `.env`에 설정하지 않으면 기본값 사용
- **권장**: 환경변수 미설정 시 서버 시작 차단 또는 랜덤 생성

---

## 테스트 요약

| 영역 | 테스트 항목 | 결과 |
|------|-----------|------|
| 인증/권한 | 비로그인 시 관리자 API 차단 | PASS |
| 인증/권한 | 일반 유저의 관리자 API 접근 차단 | PASS |
| 인증/권한 | 관리자 로그인 후 Admin 링크 표시 | PASS |
| 대시보드 | 통계 데이터 정상 로드 | PASS |
| 대시보드 | 주문 상태별 현황 표시 | PASS |
| 상품 관리 | 상품 목록 조회 | PASS |
| 상품 관리 | 음수 가격/재고 검증 | **FAIL** (BUG-001) |
| 상품 관리 | 할인가 > 정가 검증 | **FAIL** (BUG-002) |
| 상품 관리 | 상품 수정 시 sale_price 유지 | **FAIL** (BUG-003) |
| 상품 관리 | 상품 삭제 (소프트 삭제) | PASS |
| 주문 관리 | 주문 목록 조회 | PASS |
| 주문 관리 | 페이지네이션 | **FAIL** (BUG-005) |
| 주문 관리 | 상태 변경 드롭다운 옵션 | **FAIL** (BUG-006) |
| 주문 관리 | 잘못된 상태 전이 백엔드 차단 | PASS |
| 카테고리 관리 | 카테고리 목록 조회 | PASS |
| 카테고리 관리 | 카테고리 수정 시 parent_id 유지 | **FAIL** (BUG-004) |
| 카테고리 관리 | 중복 slug 에러 처리 | **FAIL** (BUG-009) |
| 모바일 반응형 | 관리자 페이지 레이아웃 | **FAIL** (BUG-008) |

**총 테스트: 17건 | PASS: 10건 | FAIL: 7건**
