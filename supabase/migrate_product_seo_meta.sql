-- SEO felter til produktsider (Google title + meta description)
alter table products add column if not exists seo_meta_title text not null default '';
alter table products add column if not exists seo_meta_description text not null default '';
