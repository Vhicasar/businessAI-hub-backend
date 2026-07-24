UPDATE "Plan"
SET "features" = COALESCE("features", '[]'::jsonb) || '["ai_insights"]'::jsonb
WHERE "slug" IN ('growth', 'business', 'enterprise')
  AND NOT COALESCE("features", '[]'::jsonb) @> '["ai_insights"]'::jsonb;
