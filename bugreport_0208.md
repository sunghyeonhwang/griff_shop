# GRIFF Shop 결제(Payment) 버그 리포트

**작성일**: 2026-02-08
**분석 범위**: 결제 플로우 전체 (Checkout → 토스페이먼츠 → 결제 승인/실패 → 주문 확정)
**관련 파일**: `server.js` (백엔드), `public/index.html` (프론트엔드)

---

## CRITICAL

### PAY-001: 결제 승인 실패 시 pending 주문이 방치됨
- **심각도**: CRITICAL
- **위치**: `public/index.html:2927-2928` (`PaymentSuccessPage` catch 블록)
- **증상**: 토스페이먼츠 결제 승인(`/api/payments/confirm`) 요청이 실패하면 에러 메시지만 표시하고, pending 상태의 주문이 취소되지 않음
- **흐름**:
  1. 사용자가 토스 결제창에서 결제 완료 → `/#/payment/success?paymentKey=...&orderId=...&amount=...` 리다이렉트
  2. `PaymentSuccessPage`에서 `/api/payments/confirm` API 호출
  3. 토스 API 승인 실패 (네트워크 오류, 타임아웃, 금액 불일치 등)
  4. **주문은 pending 상태 + 재고 차감 완료 + 장바구니 비워진 상태로 방치**
- **영향**:
  - 재고가 차감된 상태로 주문이 완료되지 않아 다른 고객이 해당 상품 구매 불가
  - 사용자의 장바구니가 비워진 상태로 복원되지 않음
  - pending 주문이 DB에 누적됨
- **기대 동작**: confirm 실패 시 `/orders/${orderId}/cancel` 호출하여 주문 취소 + 재고 복원 + 장바구니 복원

### PAY-002: 토스페이먼츠 웹훅에 서명 검증 없음
- **심각도**: CRITICAL (보안)
- **위치**: `server.js:868-912` (`POST /api/payments/webhook`)
- **증상**: 웹훅 엔드포인트가 인증/서명 검증 없이 누구나 호출 가능
- **공격 시나리오**:
  ```bash
  # 악의적 요청으로 미결제 주문을 결제 완료 처리
  curl -X POST /api/payments/webhook \
    -H "Content-Type: application/json" \
    -d '{"eventType":"PAYMENT_STATUS_CHANGED","data":{"paymentKey":"fake","status":"DONE","orderId":"123"}}'
  ```
- **영향**: 결제 없이 주문 상태가 `paid`로 변경될 수 있음 (무단 결제 완료 처리)
- **기대 동작**: 토스페이먼츠 웹훅 시크릿을 사용한 서명 검증 필수

### PAY-003: 결제 위젯 미초기화 상태에서 결제 시도 가능
- **심각도**: CRITICAL
- **위치**: `public/index.html:2422-2463` (`handlePayment` 함수)
- **증상**: `paymentWidgetRef.current`가 null이거나 `widgetReady`가 false인 상태에서 결제 버튼 클릭 시 `requestPayment` 호출이 `TypeError` 발생
- **재현 조건**: 위젯 초기화 완료 전에 결제 버튼을 빠르게 클릭
- **영향**: 주문은 생성되었지만(장바구니 비워짐 + 재고 차감) 결제는 실패하는 상황 발생
- **기대 동작**: `widgetReady` 상태가 false이면 결제 버튼 비활성화 또는 guard 조건 추가

---

## HIGH

### PAY-004: 주문 생성 후 결제 전 페이지 새로고침 시 데이터 손실
- **심각도**: HIGH
- **위치**: `public/index.html:2430-2444` (`handlePayment` 함수)
- **증상**: `handlePayment`에서 주문 생성(step 1) 후 토스 결제창(step 2) 호출 사이, 또는 토스 결제창이 열린 상태에서 사용자가 브라우저를 새로고침하면:
  1. 주문 생성으로 장바구니가 이미 비워진 상태
  2. 결제는 완료되지 않음
  3. 체크아웃 페이지에서 "장바구니가 비어있습니다" 표시
  4. catch 블록의 cancel 로직이 실행되지 않음 (페이지가 새로 로드되므로)
- **영향**: 사용자가 주문도 결제도 안 된 상태에서 장바구니와 재고를 잃음
- **기대 동작**:
  - pending 주문 ID를 sessionStorage에 저장하고, 체크아웃 페이지 로드 시 미결제 pending 주문 존재 확인
  - 또는 결제 완료 전까지 장바구니를 비우지 않는 구조로 변경

### PAY-005: 결제 금액 조작 가능성 (클라이언트 사이드)
- **심각도**: HIGH (보안)
- **위치**: `public/index.html:2921` + `server.js:809`
- **증상**: `PaymentSuccessPage`에서 URL 파라미터의 `amount` 값을 그대로 `/payments/confirm` API에 전달
- **방어 현황**: 서버에서 `Number(order.total_amount) !== Number(amount)` 검증이 있어 DB 금액과 비교하므로 **실제 공격은 차단됨**
- **잔여 리스크**: 서버 검증이 제거되거나 우회되면 취약해질 수 있음. amount를 클라이언트에서 받지 않고 서버에서 직접 DB 조회하는 것이 더 안전

### PAY-006: 웹훅에서 결제 취소/실패 시 재고 복원 없음
- **심각도**: HIGH
- **위치**: `server.js:895-907` (웹훅 주문 상태 동기화)
- **증상**: 웹훅으로 `CANCELED`/`ABORTED` 상태가 수신되면 주문 상태만 `cancelled`로 변경하고, **재고를 복원하지 않음**
- **비교**: 관리자 주문 취소(`PUT /api/admin/orders/:id/status`)에서는 재고 복원 로직이 있음
- **영향**: 토스페이먼츠 측에서 결제를 취소/환불하면 주문은 cancelled이지만 재고가 차감된 상태로 남음

### PAY-007: 동일 주문에 대한 결제 승인 중복 호출 가능
- **심각도**: HIGH
- **위치**: `public/index.html:2898-2900` (`PaymentSuccessPage` confirmedRef)
- **증상**: `confirmedRef`로 React 내 중복 호출은 방지하지만, 사용자가 성공 URL을 복사하여 다른 탭/브라우저에서 열면 다시 `/payments/confirm` 호출
- **방어 현황**: 서버에서 `order.status !== 'pending'` 체크가 있어 두 번째 요청은 `400 이미 처리된 주문` 반환. 토스 API도 중복 승인을 거부함
- **잔여 리스크**: 동시 요청 시 DB `FOR UPDATE` 잠금으로 순차 처리되나, 두 번째 요청에서 토스 API 호출 후 DB 업데이트 시점 사이에 레이스 컨디션 가능성 존재 (매우 낮음)

---

## MEDIUM

### PAY-008: 결제 승인 API 응답에서 payment_key 노출
- **심각도**: MEDIUM
- **위치**: `server.js:855-858`
- **증상**: `/api/payments/confirm` 응답으로 `payment` 객체 전체(payment_key 포함)를 클라이언트에 반환
- **영향**: payment_key가 클라이언트 측에 노출되어 토스페이먼츠 취소/조회 API에 사용될 수 있음
- **기대 동작**: 클라이언트에 필요한 정보만 선별하여 반환 (amount, method, approved_at 등)

### PAY-009: TOSS_CLIENT_KEY가 프론트엔드에 하드코딩
- **심각도**: MEDIUM
- **위치**: `public/index.html:2304`
- **증상**: `const TOSS_CLIENT_KEY = 'test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm'` — 테스트 키가 소스 코드에 하드코딩
- **현재 상태**: 테스트 키이므로 당장 위험하지 않으나, 프로덕션 전환 시 실수로 테스트 키가 남거나 프로덕션 키가 하드코딩될 위험
- **기대 동작**: 서버에서 환경변수로 관리하고, API를 통해 클라이언트에 전달하거나 빌드 시 주입

### PAY-010: 결제 실패 페이지에서 params 파싱이 컴포넌트 바디에서 실행
- **심각도**: MEDIUM
- **위치**: `public/index.html:2991-2998` (`PaymentFailPage`)
- **증상**: URL 파라미터 파싱 로직이 `useEffect` 외부(컴포넌트 바디)에서 실행됨. React가 해시 변경으로 리렌더링할 때 `window.location.hash` 값이 이미 변경된 상태일 수 있음
- **영향**: SPA 네비게이션 시 이전 해시의 파라미터를 읽거나, 파라미터 없이 빈 값이 설정될 수 있음
- **기대 동작**: `useMemo` 또는 `useEffect` 안에서 파싱

---

## LOW

### PAY-011: 결제 취소 시 토스트 메시지 구분 부족
- **심각도**: LOW (UX)
- **위치**: `public/index.html:2455-2458`
- **증상**: `err.code === 'USER_CANCEL'`이면 "결제가 취소되었습니다" info 토스트, 그 외에는 `err.message` error 토스트
- **문제**: 토스페이먼츠의 다양한 에러 코드(PAY_PROCESS_CANCELED, PAY_PROCESS_ABORTED, REJECT_CARD_COMPANY 등)에 대한 구분 없이 일괄 에러 처리
- **기대 동작**: 주요 에러 코드별 사용자 친화적 메시지 제공

### PAY-012: 결제 완료 후 fetchCart 비동기 누락
- **심각도**: LOW
- **위치**: `public/index.html:2924`
- **증상**: `PaymentSuccessPage`에서 결제 승인 성공 후 `fetchCart()` 호출 시 `await` 없음
- **영향**: 장바구니 갱신이 완료되기 전에 UI가 렌더링될 수 있으나, 결제 성공 페이지에서는 장바구니를 직접 표시하지 않으므로 실질적 영향 미미

---

## 기존 관리자 페이지 버그 (결제 관련)

이전 QA 리포트(`QA_BUG_REPORT.md`)에서 식별된 결제 관련 버그:

| ID | 버그 | 상태 |
|----|------|------|
| BUG-007 | 관리자 주문 취소 시 트랜잭션 미사용 | 미수정 |
| BUG-005 | 주문 관리 페이지네이션 미작동 (`data.total` → `data.pagination.total_count`) | 미수정 |

---

## 결제 플로우 요약 및 리스크 맵

```
[장바구니] → [체크아웃] → [주문생성 (재고차감+장바구니삭제)]
                               ↓
                         [토스 결제창]
                          /        \
                    [성공URL]    [실패URL]
                       ↓            ↓
               [/payments/confirm]  [/orders/:id/cancel] ← OK
                    /        \          (재고복원+장바구니복원)
               [승인성공]  [승인실패]
                  ↓            ↓
            [주문 paid]   [주문 pending 방치!!] ← PAY-001
                           재고 차감 상태 유지
                           장바구니 비어있음
```

### 핵심 취약 구간:
1. **주문 생성 ~ 결제 완료 사이** (PAY-003, PAY-004): 장바구니가 이미 삭제된 상태에서 결제가 실패하면 복구 메커니즘 필요
2. **결제 승인 실패 시** (PAY-001): 주문 취소 로직 없음
3. **웹훅 무인증** (PAY-002): 외부에서 결제 상태 조작 가능
4. **웹훅 취소 시 재고** (PAY-006): 재고 복원 로직 누락

---

## 우선순위 수정 권장 순서

1. **PAY-001** (결제 승인 실패 시 주문 방치) — 사용자 경험 직접 영향
2. **PAY-002** (웹훅 서명 검증) — 보안 취약점
3. **PAY-003** (위젯 미초기화 결제) — 결제 실패 시 주문 방치로 연결
4. **PAY-006** (웹훅 재고 복원) — 재고 불일치 누적
5. **PAY-004** (새로고침 데이터 손실) — 엣지 케이스지만 실제 발생 가능

---

**총 결제 버그: 12건**
| 심각도 | 건수 |
|--------|------|
| CRITICAL | 3 |
| HIGH | 4 |
| MEDIUM | 3 |
| LOW | 2 |

---

## 수정 완료 현황 (2026-02-08)

| ID | 버그 | 수정 내용 | 상태 |
|----|------|----------|------|
| **PAY-001** | 결제 승인 실패 시 주문 방치 | `PaymentSuccessPage` catch에서 `/orders/${orderId}/cancel` 호출 + 장바구니 복원 추가 | FIXED |
| **PAY-002** | 웹훅 서명 검증 없음 | `crypto.createHmac`으로 `toss-signature` 헤더 HMAC-SHA256 검증 추가 (TOSS_WEBHOOK_SECRET 환경변수) | FIXED |
| **PAY-003** | 위젯 미초기화 결제 시도 | `handlePayment`에 `widgetReady` guard 추가 + 버튼 `disabled={processing \|\| !widgetReady}` | FIXED |
| **PAY-004** | 새로고침 시 데이터 손실 | `sessionStorage`에 pending 주문 ID 저장, 체크아웃 진입 시 미결제 주문 자동 복구 | FIXED |
| **PAY-006** | 웹훅 취소 시 재고 미복원 | 웹훅 핸들러에 트랜잭션 + 재고 복원 로직 추가 (중복 복원 방지 포함) | FIXED |
| **PAY-010** | params 파싱 위치 | `PaymentFailPage`에서 컴포넌트 바디 → `useMemo`로 이동 | FIXED |
| PAY-005 | 클라이언트 금액 조작 | 서버 검증 이미 존재하여 실제 공격 차단됨 | 미수정 (위험도 낮음) |
| PAY-007 | 중복 승인 호출 | 서버 FOR UPDATE + 상태 체크로 이미 방어됨 | 미수정 (위험도 낮음) |
| PAY-008 | payment_key 응답 노출 | 향후 개선 권장 | 미수정 |
| PAY-009 | TOSS_CLIENT_KEY 하드코딩 | 향후 환경변수 전환 권장 | 미수정 |
| PAY-011 | 에러 코드별 메시지 | UX 개선 사항 | 미수정 |
| PAY-012 | fetchCart await 누락 | 실질적 영향 미미 | 미수정 |

**수정 완료: 6건 / 미수정: 6건 (위험도 낮은 항목)**
