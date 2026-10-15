//! Rust port of the panel's personal-data gate (`studio-host/src/achmage-ai/outbound-gate.ts`).
//!
//! Identifiers the patterns recognise are not sent to the AI provider: a remote prompt is masked with
//! numbered tokens before it is sent, and the reply is restored on this computer (a Telegram reply then
//! carries the restored values back through Telegram). Detection is conservative for document
//! numbers, dates and amounts (they are content, not identifiers). The detectors, their order and
//! their accept rules mirror the TypeScript regular expressions, written out by hand because the
//! originals rely on look-behind.

/// Kind of identifier, in the panel's naming.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Rrn,
    Phone,
    Email,
    Card,
    Account,
    Passport,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Self::Rrn => "주민·외국인등록번호",
            Self::Phone => "전화번호",
            Self::Email => "이메일",
            Self::Card => "카드번호",
            Self::Account => "계좌번호",
            Self::Passport => "여권번호",
        }
    }
}

/// Masked text plus the token table needed to restore the reply.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Masked {
    pub text: String,
    /// `(token, original value)` in numbering order.
    pub tokens: Vec<(String, String)>,
    pub kinds: Vec<Kind>,
}

impl Masked {
    fn token_for(&mut self, value: String, kind: Kind) -> String {
        if !self.kinds.contains(&kind) {
            self.kinds.push(kind);
        }
        if let Some((token, _)) = self.tokens.iter().find(|(_, known)| *known == value) {
            return token.clone();
        }
        let token = token(self.tokens.len() + 1);
        self.tokens.push((token.clone(), value));
        token
    }
}

fn token(n: usize) -> String {
    format!("〔개인정보{n}〕")
}

/// Masks identifiers; the same value always gets the same token within one request. `base`
/// continues the numbering of an earlier part of the same request. Escape sequences of serialized
/// text (`\n`, `\t`, `\uXXXX`) are boundaries: an identifier never swallows an escape's letter.
pub(crate) fn mask_personal(text: &str, base: Option<&Masked>) -> Masked {
    let mut masked = base.cloned().unwrap_or_default();
    masked.text.clear();
    let chars: Vec<char> = text.chars().collect();
    let mut plain = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            let unicode = chars[i + 1] == 'u'
                && chars
                    .get(i + 2..i + 6)
                    .is_some_and(|hex| hex.iter().all(char::is_ascii_hexdigit));
            let len = if unicode { 6 } else { 2 };
            let segment = mask_plain(&std::mem::take(&mut plain), &mut masked);
            masked.text.push_str(&segment);
            masked.text.extend(&chars[i..i + len]);
            i += len;
        } else {
            plain.push(chars[i]);
            i += 1;
        }
    }
    let segment = mask_plain(&plain, &mut masked);
    masked.text.push_str(&segment);
    masked
}

type Matcher = fn(&[char], usize) -> Option<usize>;
type Accept = fn(&str) -> bool;

const DETECTORS: [(Kind, Matcher, Accept); 6] = [
    (Kind::Email, email, always),
    (Kind::Rrn, rrn, rrn_valid),
    (Kind::Card, card, luhn),
    (Kind::Phone, phone, always),
    (Kind::Account, account, account_valid),
    (Kind::Passport, passport, always),
];

/// Runs every detector over the text in order, like successive global `String.replace` calls: a
/// rejected match is left as it is and scanning continues after it.
fn mask_plain(text: &str, masked: &mut Masked) -> String {
    let mut current = text.to_owned();
    for (kind, matcher, accept) in DETECTORS {
        let chars: Vec<char> = current.chars().collect();
        let mut out = String::with_capacity(current.len());
        let mut i = 0;
        while i < chars.len() {
            match matcher(&chars, i) {
                Some(end) => {
                    let found: String = chars[i..end].iter().collect();
                    if accept(&found) {
                        out.push_str(&masked.token_for(found, kind));
                    } else {
                        out.push_str(&found);
                    }
                    i = end;
                }
                None => {
                    out.push(chars[i]);
                    i += 1;
                }
            }
        }
        current = out;
    }
    current
}

fn at(chars: &[char], i: usize) -> Option<char> {
    chars.get(i).copied()
}

fn before(chars: &[char], i: usize) -> Option<char> {
    i.checked_sub(1).and_then(|j| at(chars, j))
}

/// `[\d-]` for the `(?<![\d-])` / `(?![\d-])` boundaries.
fn digit_or_hyphen(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_digit() || c == '-')
}

fn digits_exact(chars: &[char], i: usize, n: usize) -> bool {
    chars
        .get(i..i + n)
        .is_some_and(|run| run.iter().all(char::is_ascii_digit))
}

fn digit_run(chars: &[char], i: usize) -> usize {
    chars
        .get(i..)
        .map_or(0, |rest| rest.iter().take_while(|c| c.is_ascii_digit()).count())
}

/// JavaScript `\s`.
fn js_space(c: Option<char>) -> bool {
    matches!(
        c,
        Some(
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}'
                | '\u{2000}'..='\u{200a}'
                | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    )
}

fn always(_: &str) -> bool {
    true
}

fn digits(value: &str) -> Vec<u32> {
    value.chars().filter_map(|c| c.to_digit(10)).collect()
}

/// `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`
fn email(chars: &[char], i: usize) -> Option<usize> {
    let local = |c: &char| c.is_ascii_alphanumeric() || "._%+-".contains(*c);
    let domain = |c: &char| c.is_ascii_alphanumeric() || ".-".contains(*c);
    let at_sign = i + chars.get(i..)?.iter().take_while(|c| local(c)).count();
    if at_sign == i || at(chars, at_sign) != Some('@') {
        return None;
    }
    let start = at_sign + 1;
    let run = chars.get(start..)?.iter().take_while(|c| domain(c)).count();
    // Greedy domain part, backing off until `.` plus two or more letters follows.
    (1..=run).rev().find_map(|k| {
        let dot = start + k;
        if at(chars, dot) != Some('.') {
            return None;
        }
        let letters = chars
            .get(dot + 1..)?
            .iter()
            .take_while(|c| c.is_ascii_alphabetic())
            .count();
        (letters >= 2).then_some(dot + 1 + letters)
    })
}

/// `(?<![\d-])\d{6}\s?-?\s?[1-8]\d{6}(?![\d-])`
fn rrn(chars: &[char], i: usize) -> Option<usize> {
    if digit_or_hyphen(before(chars, i)) || !digits_exact(chars, i, 6) {
        return None;
    }
    let mut j = i + 6;
    if js_space(at(chars, j)) {
        j += 1;
    }
    if at(chars, j) == Some('-') {
        j += 1;
    }
    if js_space(at(chars, j)) {
        j += 1;
    }
    if !matches!(at(chars, j), Some('1'..='8')) || !digits_exact(chars, j + 1, 6) {
        return None;
    }
    let end = j + 7;
    (!digit_or_hyphen(at(chars, end))).then_some(end)
}

fn rrn_valid(value: &str) -> bool {
    let d = digits(value);
    if d.len() != 13 {
        return false;
    }
    let month = d[2] * 10 + d[3];
    let day = d[4] * 10 + d[5];
    // Registrations since late 2020 carry no check digit; a plausible date and gender digit is enough.
    (1..=12).contains(&month) && (1..=31).contains(&day) && (1..=8).contains(&d[6])
}

/// `(?<![\d-])(?:\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{2,4}|\d{15,16})(?![\d-])`
fn card(chars: &[char], i: usize) -> Option<usize> {
    if digit_or_hyphen(before(chars, i)) {
        return None;
    }
    let grouped = || {
        let mut j = i;
        for _ in 0..3 {
            if !digits_exact(chars, j, 4) || !matches!(at(chars, j + 4), Some(' ' | '-')) {
                return None;
            }
            j += 5;
        }
        (2..=4)
            .rev()
            .find(|&n| digits_exact(chars, j, n) && !digit_or_hyphen(at(chars, j + n)))
            .map(|n| j + n)
    };
    grouped().or_else(|| {
        [16, 15]
            .into_iter()
            .find(|&n| digits_exact(chars, i, n) && !digit_or_hyphen(at(chars, i + n)))
            .map(|n| i + n)
    })
}

fn luhn(value: &str) -> bool {
    let d = digits(value);
    if !(13..=19).contains(&d.len()) {
        return false;
    }
    let sum: u32 = d
        .iter()
        .rev()
        .enumerate()
        .map(|(index, &n)| {
            if index % 2 == 1 {
                let doubled = n * 2;
                if doubled > 9 {
                    doubled - 9
                } else {
                    doubled
                }
            } else {
                n
            }
        })
        .sum();
    sum.is_multiple_of(10)
}

fn separator(c: Option<char>) -> bool {
    matches!(c, Some(' ' | '.' | '-'))
}

/// Korean numbering: mobile 01x, Seoul 02, area 0[3-6][1-5], 070; `+82` drops the leading 0.
/// `(?:\+82[ .-]?(?:1[016789]|2|[3-6][1-5]|70)|(?<![\d-])\(?(?:01[016789]|02|0[3-6][1-5]|070)\)?)`
/// `[ .-]?\d{3,4}[ .-]?\d{4}(?![\d-])`
fn phone(chars: &[char], i: usize) -> Option<usize> {
    let prefix_end = if at(chars, i) == Some('+') {
        if at(chars, i + 1) != Some('8') || at(chars, i + 2) != Some('2') {
            return None;
        }
        let j = if separator(at(chars, i + 3)) { i + 4 } else { i + 3 };
        match (at(chars, j), at(chars, j + 1)) {
            (Some('1'), Some('0' | '1' | '6' | '7' | '8' | '9')) => j + 2,
            (Some('2'), _) => j + 1,
            (Some('3'..='6'), Some('1'..='5')) => j + 2,
            (Some('7'), Some('0')) => j + 2,
            _ => return None,
        }
    } else {
        if digit_or_hyphen(before(chars, i)) {
            return None;
        }
        let j = if at(chars, i) == Some('(') { i + 1 } else { i };
        let area_end = match (at(chars, j), at(chars, j + 1), at(chars, j + 2)) {
            (Some('0'), Some('1'), Some('0' | '1' | '6' | '7' | '8' | '9')) => j + 3,
            (Some('0'), Some('2'), _) => j + 2,
            (Some('0'), Some('3'..='6'), Some('1'..='5')) => j + 3,
            (Some('0'), Some('7'), Some('0')) => j + 3,
            _ => return None,
        };
        if at(chars, area_end) == Some(')') {
            area_end + 1
        } else {
            area_end
        }
    };
    let start = if separator(at(chars, prefix_end)) {
        prefix_end + 1
    } else {
        prefix_end
    };
    [4, 3].into_iter().find_map(|first| {
        if !digits_exact(chars, start, first) {
            return None;
        }
        let mut k = start + first;
        if separator(at(chars, k)) {
            k += 1;
        }
        (digits_exact(chars, k, 4) && !digit_or_hyphen(at(chars, k + 4))).then_some(k + 4)
    })
}

/// Bank accounts: three or four hyphenated digit groups.
/// `(?<![\d-])\d{2,6}-\d{2,6}-\d{2,7}(?:-\d{1,3})?(?![\d-])`
fn account(chars: &[char], i: usize) -> Option<usize> {
    if digit_or_hyphen(before(chars, i)) {
        return None;
    }
    let first = digit_run(chars, i);
    if !(2..=6).contains(&first) || at(chars, i + first) != Some('-') {
        return None;
    }
    let j = i + first + 1;
    let second = digit_run(chars, j);
    if !(2..=6).contains(&second) || at(chars, j + second) != Some('-') {
        return None;
    }
    let k = j + second + 1;
    let third = digit_run(chars, k);
    if !(2..=7).contains(&third) {
        return None;
    }
    let end = k + third;
    if at(chars, end) == Some('-') {
        let fourth = digit_run(chars, end + 1);
        let tail = end + 1 + fourth;
        if (1..=3).contains(&fourth) && !digit_or_hyphen(at(chars, tail)) {
            return Some(tail);
        }
    }
    (!digit_or_hyphen(at(chars, end))).then_some(end)
}

/// 10–14 digits; not a year-led document or project number (2024-0012-345) and not a business
/// registration number (123-45-67890, public).
fn account_valid(value: &str) -> bool {
    let count = digits(value).len();
    let groups: Vec<&str> = value.split('-').collect();
    let year_led = groups[0].len() == 4 && (groups[0].starts_with("19") || groups[0].starts_with("20"));
    let business = groups.len() == 3 && groups[0].len() == 3 && groups[1].len() == 2 && groups[2].len() == 5;
    (10..=14).contains(&count) && !year_led && !business
}

/// `(?<![A-Za-z0-9])[MSROD]\d{8}(?![A-Za-z0-9])|(?<![A-Za-z0-9])[MSROD]\d{3}[A-Z]\d{4}(?![A-Za-z0-9])`
fn passport(chars: &[char], i: usize) -> Option<usize> {
    let alnum = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric());
    if alnum(before(chars, i)) || !matches!(at(chars, i), Some('M' | 'S' | 'R' | 'O' | 'D')) {
        return None;
    }
    let j = i + 1;
    let plain = digits_exact(chars, j, 8);
    let lettered = digits_exact(chars, j, 3)
        && at(chars, j + 3).is_some_and(|c| c.is_ascii_uppercase())
        && digits_exact(chars, j + 4, 4);
    ((plain || lettered) && !alnum(at(chars, j + 8))).then_some(j + 8)
}

/// Result of restoring a reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Restored {
    pub text: String,
    /// Tokens in the reply that this request never sent; left as they are.
    pub unknown: Vec<String>,
    /// Sent tokens the reply did not use.
    pub missing: usize,
}

/// Puts the original values back. Models sometimes rewrite the brackets (`[개인정보1]`); those
/// are still tokens. Tokens the request never sent cannot be restored and are reported.
pub(crate) fn restore_personal(reply: &str, masked: &Masked) -> Restored {
    const WORD: [char; 4] = ['개', '인', '정', '보'];
    let chars: Vec<char> = reply.chars().collect();
    let mut text = String::with_capacity(reply.len());
    let mut unknown = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let open = matches!(chars[i], '〔' | '[');
        let word = chars.get(i + 1..i + 5) == Some(&WORD[..]);
        let number = if open && word { digit_run(&chars, i + 5) } else { 0 };
        let close = i + 5 + number;
        if number == 0 || !matches!(at(&chars, close), Some('〕' | ']')) {
            text.push(chars[i]);
            i += 1;
            continue;
        }
        let found: String = chars[i..=close].iter().collect();
        let digits: String = chars[i + 5..close].iter().collect();
        let canonical = digits.parse::<u64>().ok().map(|n| format!("〔개인정보{n}〕"));
        match canonical.and_then(|canonical| masked.tokens.iter().find(|(token, _)| *token == canonical)) {
            Some((token, value)) => {
                text.push_str(value);
                if !seen.contains(&token.as_str()) {
                    seen.push(token);
                }
            }
            None => {
                text.push_str(&found);
                unknown.push(found);
            }
        }
        i = close + 1;
    }
    let missing = masked.tokens.len() - seen.len();
    Restored {
        text,
        unknown,
        missing,
    }
}

/// One line for the reply, e.g. "개인정보 2건(전화번호·이메일)을 가리고 보냈습니다. ...".
pub(crate) fn mask_notice(masked: &Masked) -> String {
    if masked.tokens.is_empty() {
        return String::new();
    }
    let kinds: Vec<&str> = masked.kinds.iter().map(|kind| kind.label()).collect();
    format!(
        "개인정보 {}건({})을 가리고 보냈습니다. 결과에는 원래 값으로 되돌려 넣습니다.",
        masked.tokens.len(),
        kinds.join("·")
    )
}

#[cfg(test)]
mod tests {
    //! Mirrors `outbound-gate.test.ts` case by case.
    use super::*;

    fn values(masked: &Masked) -> Vec<&str> {
        masked.tokens.iter().map(|(_, value)| value.as_str()).collect()
    }

    #[test]
    fn masks_each_identifier_kind_and_restores_it() {
        let cases = [
            ("주민번호 900101-1234567 확인", Kind::Rrn, "900101-1234567"),
            ("외국인 9001015234567", Kind::Rrn, "9001015234567"),
            ("연락처 010-1234-5678", Kind::Phone, "010-1234-5678"),
            ("휴대폰 01012345678로", Kind::Phone, "01012345678"),
            ("대표 02-123-4567", Kind::Phone, "02-123-4567"),
            ("지역 031 765 4321", Kind::Phone, "031 765 4321"),
            ("국제 +82 10-9876-5432", Kind::Phone, "+82 10-9876-5432"),
            ("메일 hong.gildong@example.ac.kr 로", Kind::Email, "hong.gildong@example.ac.kr"),
            ("카드 4111 1111 1111 1111 결제", Kind::Card, "4111 1111 1111 1111"),
            ("계좌 110-123-456789 (신한)", Kind::Account, "110-123-456789"),
            ("여권 M12345678 제출", Kind::Passport, "M12345678"),
        ];
        for (text, kind, value) in cases {
            let masked = mask_personal(text, None);
            assert!(!masked.text.contains(value), "{text} -> {}", masked.text);
            assert!(masked.text.contains("〔개인정보1〕"), "{text} -> {}", masked.text);
            assert_eq!(masked.kinds, vec![kind], "{text}");
            assert_eq!(
                restore_personal(&masked.text, &masked),
                Restored {
                    text: text.to_owned(),
                    unknown: vec![],
                    missing: 0
                }
            );
        }
    }

    #[test]
    fn leaves_content_alone() {
        for text in [
            "시행일 2026. 10. 14.(수)",
            "2026-10-14 회의",
            "문서번호 제2026-123호",
            "예산 금1,234,567,890원",
            "증가율 12.5%",
            "전화 1588-1234",
            "20261014",
            "학번 20231234",
            "사업비 3,500,000원",
            "쪽 12-3",
            "4111 1111 1111 1112",
            "버전 1.2.3",
            "1234-5678",
        ] {
            let masked = mask_personal(text, None);
            assert_eq!(masked.text, text);
            assert!(masked.tokens.is_empty(), "{text}: {:?}", masked.tokens);
            assert_eq!(mask_notice(&masked), "");
        }
    }

    #[test]
    fn reuses_tokens_restores_every_occurrence_and_reports_dropped_or_invented_tokens() {
        let masked = mask_personal("담당 010-1234-5678, 문의 010-1234-5678, 메일 a@example.com", None);
        assert_eq!(masked.text, "담당 〔개인정보2〕, 문의 〔개인정보2〕, 메일 〔개인정보1〕");
        assert_eq!(
            mask_notice(&masked),
            "개인정보 2건(이메일·전화번호)을 가리고 보냈습니다. 결과에는 원래 값으로 되돌려 넣습니다."
        );
        assert_eq!(
            restore_personal("연락: 〔개인정보2〕 / 〔개인정보2〕", &masked),
            Restored {
                text: "연락: 010-1234-5678 / 010-1234-5678".into(),
                unknown: vec![],
                missing: 1
            }
        );
        assert_eq!(restore_personal("〔개인정보7〕", &masked).unknown, vec!["〔개인정보7〕"]);
    }

    #[test]
    fn replies_with_tokens_that_were_never_sent_are_not_restored() {
        let masked = mask_personal("안녕하세요", None);
        let restored = restore_personal("〔개인정보1〕 [개인정보02]", &masked);
        assert_eq!(restored.text, "〔개인정보1〕 [개인정보02]");
        assert_eq!(restored.unknown.len(), 2);
    }

    #[test]
    fn extends_one_request_across_parts_with_stable_numbering() {
        let first = mask_personal("본문 010-1111-2222", None);
        let second = mask_personal("대화 010-1111-2222 그리고 x@example.org", Some(&first));
        assert_eq!(second.text, "대화 〔개인정보1〕 그리고 〔개인정보2〕");
        assert_eq!(second.tokens.len(), 2);
    }

    #[test]
    fn masks_inside_serialized_text_without_swallowing_escapes() {
        let payload = serde_json::to_string("담당자\nhong@example.com\t010-1234-5678").unwrap();
        let masked = mask_personal(&payload, None);
        assert_eq!(values(&masked), vec!["hong@example.com", "010-1234-5678"]);
        assert_eq!(
            masked.text,
            serde_json::to_string("담당자\n〔개인정보1〕\t〔개인정보2〕").unwrap()
        );
        assert_eq!(restore_personal(&masked.text, &masked).text, payload);
    }

    #[test]
    fn does_not_treat_document_or_business_numbers_as_accounts() {
        for text in ["2024-0012-345", "2024-12-345678", "2024-001234-01", "사업자 123-45-67890"] {
            assert!(mask_personal(text, None).tokens.is_empty(), "{text}");
        }
    }

    #[test]
    fn masks_phone_formats_with_dots_and_parentheses() {
        for text in ["(02)1234-5678", "010.1234.5678", "(031) 765-4321"] {
            assert_eq!(mask_personal(text, None).kinds, vec![Kind::Phone], "{text}");
        }
    }

    #[test]
    fn restores_tokens_whose_brackets_the_model_rewrote() {
        let masked = mask_personal("문의 a@example.com", None);
        assert_eq!(
            restore_personal("문의: [개인정보1]", &masked),
            Restored {
                text: "문의: a@example.com".into(),
                unknown: vec![],
                missing: 0
            }
        );
    }
}
