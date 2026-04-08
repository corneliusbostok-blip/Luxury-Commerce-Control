-- Add product categories (run in Supabase SQL Editor if `products` already exists without `category`)

alter table products add column if not exists category text not null default 'other';

create index if not exists products_category_idx on products (category);

-- Optional: best-effort relabel existing rows from product name
update products set category = 'watches' where category = 'other' and (name ilike '%watch%' or name ilike '%chronograph%');
update products set category = 'footwear' where category = 'other' and (name ilike '%sneaker%' or name ilike '%boot%' or name ilike '%shoe%');
update products set category = 'bags' where category = 'other' and (name ilike '%bag%' or name ilike '%briefcase%' or name ilike '%backpack%');
update products set category = 'outerwear' where category = 'other' and (name ilike '%jacket%' or name ilike '%coat%');
update products set category = 'accessories' where category = 'other' and (name ilike '%belt%' or name ilike '%sunglasses%' or name ilike '%wallet%');
update products set category = 'apparel' where category = 'other' and (name ilike '%sweater%' or name ilike '%shirt%' or name ilike '%merino%');
