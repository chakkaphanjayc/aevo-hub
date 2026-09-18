-- Keep global text search portable across PostgREST's embedded relation
-- filter boundary. Relation fields remain searchable through explicit field
-- syntax (for example category.name:"hardware") and the filter builder.

update public.query_models
set default_search_fields = case technical_name
  when 'product.product' then '["name", "sku", "description"]'::jsonb
  when 'sale.order' then '["order_number", "customer_name", "customer_phone", "customer_email"]'::jsonb
  else default_search_fields
end,
updated_at = timezone('utc', now())
where technical_name in ('product.product', 'sale.order');

