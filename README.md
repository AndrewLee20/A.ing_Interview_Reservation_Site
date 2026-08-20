# A.ing Interview Reservation Site

A.ing 동아리 면접 시간 예약 서비스입니다.

- 지원자: 이름과 전화번호 뒷 4자리 로그인, 날짜별 슬롯 조회, 예약·변경·취소
- 관리자: 지원자 관리, 기간별 슬롯 생성, 날짜별 슬롯 관리, 강제 예약 배정
- 안전한 삭제: 삭제 대상 미리보기, 날짜별 삭제, 삭제 이력 및 복구

운영 사이트: https://aing-interview.vercel.app

## 환경 변수

Vercel 또는 로컬 실행 환경에 다음 값을 설정해야 합니다.

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` 또는 `SUPABASE_SERVICE_ROLE_KEY`
- `SESSION_SECRET`
- `IDENTITY_PEPPER`
- `ADMIN_PASSWORD`

## 실행

```bash
pnpm install
vercel dev
```

DB 변경 이력은 `supabase/migrations`에 있습니다.
