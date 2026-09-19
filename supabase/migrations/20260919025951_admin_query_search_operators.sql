-- Field expressions such as status:ACTIVE should be valid in every Admin
-- list. The parser intentionally emits `contains` for a bare field:value
-- expression, so the metadata must advertise that operator for text-like
-- selection fields.

update public.query_model_fields f
set operators = f.operators || '["contains"]'::jsonb,
    updated_at = timezone('utc', now())
from public.query_models m
where f.model_id = m.id
  and m.module = 'admin'
  and f.path in ('status', 'currency')
  and not (f.operators ? 'contains');
