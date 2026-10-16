# 자연어 문서 명령 라우팅 감사 — 2026-10-16

(감사 당시 기준. 이후 표 구조·여러 칸·표 단위 체크박스 편집이 추가되었습니다. docs/ai-workflow-upgrade.md 참고)

## 결론

기본 채팅에는 AI 라우터가 있지만, 그 앞·뒤와 인라인/원격 경로에 자연어 정규식·부분 문자열 분기가 남아 있다. 따라서 AI가 명령을 이해해도 다른 경로에서 다시 해석해 실행 종류·범위·속성을 바꾸거나 거절할 수 있다. 동의어를 계속 추가하는 방식으로 해결할 수 없다.

검사 기준: public `becec1b`(1.1.0)와 PR #1 후 `8a27a69`, PR #2 작업본 `8e69b99`. 아래 함수명은 해당 소스에서 검색할 수 있다. 이 문서는 감사 및 변경 계약이며, 아래 항목 전체를 이미 수정했다는 뜻이 아니다.

## 범위와 방법

- HOP 소유 `apps/studio-host/src` 및 `apps/desktop`의 실행 소스에서 정규식, `test`/`match`/`matchAll`, `includes`/`contains`, 접두사 검사와 자연어 상수를 조사하고 실제 호출자를 추적했다.
- `achmage-ai` TypeScript에서 정규식 검사 검색 결과 108줄을 분류했다. 이는 명령 판별기 개수가 아니라 스키마·데이터 파서까지 포함한 검색 줄 수다.
- 패널 기본 채팅, 인라인 선택/전체 편집, 서식 버튼, 장문 원고, 원격 Telegram 분기를 확인했다. upstream 엔진은 실행 계약을 확인하는 읽기 전용 대상으로 취급했다. 생성 산출물·외부 의존성·테스트 문자열은 활성 명령 판별기로 집계하지 않았다.
- 제품 정책상 공개판에서 제외된 이미지 기능은 재활성화 대상이 아니다.
- 아래 21항은 검색식을 하나씩 센 것이 아니라 호출 경로 및 역할별 감사 항목이다. 런타임 조합·모든 자연어 표현을 전수 실행한 결과는 아니다.

## 자연어 판별 목록

경로 약어: AI=`apps/studio-host/src/achmage-ai`, TG=`apps/desktop/src-tauri/src/achmage_telegram`.

| # | 위치·함수 | 현재 판별 내용과 적용 경로 | 문제/처리 원칙 |
|---|---|---|---|
| 1 | AI/document-intent.ts `informationalRequest` | 방법·차이·무엇·어떻게·질문 종결어로 실행 요청 제외 | ‘어떻게든 고쳐줘’ 같은 명령도 질문으로 간주할 수 있음. AI 의도 판정으로 통합 |
| 2 | 같은 파일 `reviewRequest` | 검토·봐줘·어때 등으로 문서 재작성 제외 | 단어가 아니라 질문/편집 의도를 모델이 구분 |
| 3 | 같은 파일 `asksForEditing` | 수정·고쳐·바꿔·요약·번역 등 고정 동사 | ‘매끈하게 손봐줘’ 누락 확인. 인라인/구 경로에 영향 |
| 4 | 같은 파일 `documentRequestText`, `asksForDocumentWriting`, `REQUEST_ENDING` | 대상 명사+작성 동사+종결어 및 부정 예외 | ‘보고서 하나 뽑아줘’ 누락. 부정 범위와 작성 여부를 구조화된 계획으로 |
| 5 | 같은 파일 `mentionsWholeDocument` | 문서 전체·전체 본문 및 근접 부정 | 전체/부분 범위를 문장 정규식에 의존. UI 선택·모델 scope로 대체 |
| 6 | 같은 파일 `asksForWholeDocumentRecomposition` | 전체+서식+행동 단어, 제외어, 표지/목차 특례 | 복잡한 동의어·거리 규칙. 재작성/서식 변경을 서로 다른 명시 작업으로 |
| 7 | 같은 파일 `shouldUseStructuredEdit` | 소제목·문단 수·표·폰트·pt 등 | ‘중간 제목을 넣어줘’ 누락. 작업 기능과 대상 구조에 따라 판단 |
| 8 | AI/request-route.ts `needsStructure`, `classifyRequest`; AI/panel.ts `send` | 선택, Ctrl+A, editMode, router=false에서 로컬 분류. 인라인은 구조 단어가 있을 때만 AI로 우회 | 일반 채팅과 인라인이 서로 다른 언어를 이해함. UI는 대상만 고정하고 자유 입력의 의도는 동일 라우터로 |
| 9 | AI/manuscript.ts `asksOnlyForLook`; AI/panel.ts `lookOnlyRoute` | 서식 관련 단어+내용 수정 단어 부재이면 AI 호출 전 조판 | 가장 높은 우선순위. 부재를 보존 의도로 해석하면 내용 수정 요구가 사라짐. 명시 버튼만 AI 없는 경로 허용 |
| 10 | AI/manuscript.ts `REWRITE_REQUEST`, `CONTENT_CHANGE_REQUEST`, `AS_WRITTEN_REQUEST`; panel `compose` | AI 라우팅 후에도 ‘원문 그대로 조판’/다시 작성 여부 재판정; 장문 8,000자 분기 | 모델 결정을 정규식이 뒤집을 수 있음. preserve/rewrite를 검증된 계획 속성으로 전달 |
| 11 | AI/manuscript.ts `splitManuscript`, `routerMessage`; document-intent `styleInstructions` | 아래/위 원고 표현, 첫 줄·마지막 줄, 4,000자 기준, Markdown/인용 시작으로 지시/원문 분리 | 입력 전처리지만 모델이 보는 명령을 바꿈. 원고 별도 필드 또는 분리 근거·원문 참조를 유지 |
| 12 | AI/document-intent.ts `explicitStyle`, `resolveTemplate` | pt, 자간, 줄간격, 굵게, 정렬 및 제목/본문/표 역할을 자연어에서 추출 | ‘중앙으로’, 역할별 반복·부정·복수 글꼴이 잘못 결합될 수 있음. 모델의 typed style patch + 값 검증으로 |
| 13 | 같은 파일 `requestedFonts`, `relevantFonts` | 설치 글꼴명 부분 검색·조사·최장 이름·오타 별칭 | 글꼴 후보 탐색에는 유용. 요청 여부/역할을 확정하는 근거로 쓰지 말 것. 설치 목록 검증은 유지 |
| 14 | 같은 파일 `prepareStructuredEdit` | scope가 없으면 ‘방금/아까…쓴/글’로 이전 결과 추정, 작성어로 삽입 판단 | 라우팅 결과 누락 시 재해석. targetId/revision/range를 반드시 명시하고 누락 시 확인 |
| 15 | AI/intent-router.ts `WHOLE_DOCUMENT_SCOPE`; panel `routeReply` | ‘문서·서식·확장’ 등이 있으면 전체 편집 추가 확인을 생략할 수 있음 | 단순 단어 존재는 전체 변경 동의가 아님. 명시 scope 및 원본 대상 검증; 불확실하면 범위 선택 |
| 16 | 같은 파일 `mentionsTemplate` | 이름 일부(3글자 이상) 포함이면 모델이 고른 템플릿 허용 | ‘한림대’만으로 여러 기관 양식이 매칭될 수 있음. templateId를 사용자 선택 또는 모호성 확인으로 확정 |
| 17 | AI/panel.ts 구조 편집 catch | 구 경로에서 `mentionsWholeDocument`이고 표 등이 지원 불가면 템플릿 재구성으로 fallback | 기능 미지원이 다른 파괴 범위 작업으로 승격됨. 실패는 정확히 알리고 자동 작업 변경 금지 |
| 18 | TG/router.rs `open_document_intent` | 띄워둔문서·현재문서 등 8문구로 AskHint | 데스크톱과 다른 자연어 경로. 동일 의도 계약, 원격 권한·문서 선택은 별도 |
| 19 | TG/router.rs `make_intent` | 문서명/한글파일 + 만들어줘·써주세요 등 8동사 | 구어체·부정 처리 취약. 의미 라우터로 통합 |
| 20 | TG/remote_templates.rs `KINDS`, `names_kind`, `choose` | 고정 문서 종류/기관 키워드의 첫 일치로 서식 선택 | 여러 종류 언급·부정도 첫 일치. 사용자 템플릿 선택/typed plan으로 |
| 21 | AI/checkbox-edit.ts 과거 `asksToClearCheckboxes` | 전체 단어+체크박스+해제 종결어 | ‘모든’ 누락을 실제 사용자 신고로 확인. PR #2에서 제거하고 `clear_checkboxes` + scope 계약으로 전환 |

## 함수 수준에서 실제 확인한 반례

아래는 해당 함수의 반환값을 실행해 확인한 것이며, 모든 UI 경로의 최종 동작을 재현했다는 뜻은 아니다.

| 입력 | 함수 | 관찰 |
|---|---|---|
| 문장을 매끈하게 손봐줘 | asksForEditing | false |
| 보고서 하나 뽑아줘 | asksForDocumentWriting | false |
| 중간 제목을 넣어줘 | shouldUseStructuredEdit | false |
| 이 문서 전체를 서식에 맞춰 군더더기를 덜어내줘 | asksOnlyForLook | true: 내용 축약 의도를 서식 전용으로 오인할 소지 |
| 이 문서에서 한 칸만 고쳐줘 | WHOLE_DOCUMENT_SCOPE | true: 전체 범위 증거로 부적절 |
| 한림대 양식으로 / 후보 한림대 AI융합연구원 보고서 | mentionsTemplate | true: 기관명이 같은 복수 후보 구분 불가 |

## 제거 대상과 구분해 유지할 결정론적 처리

- JSON 작업 ID·필수 키·숫자/색/폰트 값·스키마·길이·파일/인증 토큰 형식 검사.
- 문서 revision·선택 범위·셀 주소·개체 타입 검증, 지원 API 확인, 단일 트랜잭션·Undo·실패 복원.
- 명시적인 버튼/메뉴/슬래시 명령 처리. 사용자가 실제로 고른 UI 작업은 문장 해석이 필요 없다.
- Markdown/표/목차 파싱, 숫자 계산, 문서 내용에서 제목 후보를 찾는 `outline-ast`, `style-contract`, `toc-pages` 등. 이들은 콘텐츠 분석이며 명령 이해가 아니다. 단, 분석 결과가 편집 범위를 넓히는 근거가 되어서는 안 된다.
- 비밀정보 마스킹·경로·파일 포맷 검사. 자연어 우회 문제를 핑계로 제거하지 않는다.

## 목표 실행 계약

모든 자유 입력은 하나의 의미 라우터를 통과한다. UI에서 확정한 문서/선택 범위와 읽은 문서 상태를 함께 제공한다. 라우터는 operation, scope, target references, contentMode(preserve/rewrite), typed style patch, template choice 또는 clarification을 반환한다. 앱은 등록된 작업·권한·지원 범위·문서 revision·선택 유효성을 검사하고 실행한다. 실행기가 원문 문장을 다시 정규식으로 해석해 다른 작업/범위로 바꾸지 않는다.

AI가 기능을 ‘알아들음’과 실제 문서 편집 API가 존재함은 별개다. 현재 셀 텍스트 편집·전체 양식 체크박스 해제는 가능하지만 임의 행/열 삽입·삭제·병합, 여러 셀 동시 수정, 특정 표만 체크 해제, 문자/그림 체크 표시는 각각 별도 실행기가 필요하다. 기능 목록에는 검증된 실행기만 광고한다.

## 기능별 후속 PR 순서와 완료 조건

1. **체크박스 의미 라우팅 (#2)**: 정규식 제거, 문서 scope 검증. 실제 Claude Sonnet 6개 구어체 + 부분 범위/부정 2개를 합성 문서 상태로 확인; UI/실행 계약 회귀 96개 통과. 특정 어휘를 넣은 stub 테스트만으로 의미 이해를 입증하지 않는다.
2. **사이드 패널·인라인 단일 라우팅**: #1~8,14,17. UI 대상은 유지하고 요청 문장으로 실행 종류를 재판정하지 않음. 표가 지원되지 않을 때 재조판으로 승격하지 않음.
3. **내용 보존/재작성 및 범위 계약**: #9~11,15. AI 이전 fast path와 AI 이후 의미 재판정 제거. 글 내용 보존은 입력·출력 텍스트 비교로 검증.
4. **템플릿·글꼴·역할 속성 계획**: #12~13,16. typed patch, 다중 후보 확인, 설치 글꼴 검증. ‘가운데’, 인용문, 부정, 복수 역할 테스트.
5. **Telegram 의미 라우팅**: #18~20. 슬래시 명령 유지, 자연어 계획 계약 공유; 원격 권한과 선택 문서 검증 유지.

각 PR은 단독 변경·회귀·미지원 범위를 기록한다. 공통 검증 행렬은 구어체/띄어쓰기/강조·오타/부정/부분 범위/대명사·후속 요청/인용 원문 속 명령/표·개체 포함/오래된 선택/모델의 잘못된 작업 ID를 포함한다. 보지 못한 표현을 포함한 실제 모델 평가와 실행기 테스트를 분리해 보고한다.
