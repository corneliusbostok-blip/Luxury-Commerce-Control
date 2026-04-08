-- Seneste SEO-scan (Gemini/fallback) — bruges til 15-dages gen-tjek i admin.
alter table products add column if not exists seo_last_checked_at timestamptz;
