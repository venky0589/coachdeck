-- Manual billing trigger: run this any time you want to force-generate invoices
-- for the current month (idempotent — safe to run multiple times).
--
-- Usage (set your own DB password — this used to hardcode one):
--   PGPASSWORD=<your-db-password> psql -U postgres -h localhost -d badminton_coach -f sql/run-billing.sql

SELECT generate_monthly_invoices(
    DATE_TRUNC('month', CURRENT_DATE)::date
);

-- Show what was generated. monthly_dues has no "gross_amount" column — the
-- pre-discount amount is base_fee; this used to reference a column that
-- never existed and would fail every time.
SELECT
    p.full_name,
    md.billing_month,
    md.base_fee,
    md.discount,
    md.balance_due,
    md.status
FROM monthly_dues md
JOIN players p ON p.id = md.player_id
WHERE md.billing_month = TO_CHAR(CURRENT_DATE, 'YYYY-MM')
ORDER BY p.full_name;
