# Provider model catalog and Claude streaming

Background: public 1.1.0 routes GPT through an installed Codex CLI and Claude through its official CLI using separate app-owned profiles.
Problem: Linux desktop PATH selects Codex 0.153.4 while installed ChatGPT bundles 0.160.0; the former reports the old catalog. Claude CLI completes a minimal request but emits rate_limit_event, rejected as unknown_event by HOP. Claude models are hardcoded to an empty list.
Goal: prefer the installed application engine where supported, display live Claude model choices, accept the known informational stream event while retaining strict tool/error/terminal checks.
Non-goals: hardcode current model names, migrate credentials, enable tools, image generation, alter subscription entitlements.
Implementation: add Linux bundled engine discovery with override precedence; query Claude initialize control response without inference, bounded parsing and generation fences; surface catalog status/refresh; map rate-limit informational event separately from terminal errors.
Verification: CLI reproduction with app-owned profile (no token reads/copies), catalog and stream regression fixtures, native tests, panel tests, typecheck/build, installed-path smoke test. Prior installation and fonts retained for rollback.
Observed: official Claude 2.1.285 returned success for a tools-disabled minimal request; its rate_limit_event caused HOP to fail. Initialize reports resolved models and aliases. Codex 0.160.0 model/list returned gpt-6.1-sol and GPT-6 family using the same HOP profile; 0.153.4 cached list is old.
References: https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server and https://code.claude.com/docs/en/cli-reference . Catalog presence alone does not establish inference entitlement.

Results: provider tests 39/39, panel tests 80/80, native discovery tests 4/4, TypeScript check and Linux native build passed. Live HOP host requests completed with GPT-6.1-Sol and Claude Opus; other listed models were catalog-checked only. Installed binary startup, Kordoc and HY신명조 loading passed; 667 protected font/config hashes unchanged. Windows/macOS runtime behavior was not exercised.
