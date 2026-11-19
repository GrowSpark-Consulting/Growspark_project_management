-- ============================================================================
-- Project Management — Migration 5: money as Decimal(14,2) + ISO currency code
--
-- GSC platform data rule: "Money is Decimal(14,2) plus an ISO currency code (INR).
-- Never floats." Fix-forward (earlier migrations are not edited).
-- Widening numeric precision keeps every existing value; nothing is dropped.
-- ============================================================================

-- Project budget and hourly rate (manager-only table from migration 4)
ALTER TABLE public.project_financials
  ALTER COLUMN budget TYPE numeric(14,2),
  ALTER COLUMN hourly_rate TYPE numeric(14,2),
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR';
ALTER TABLE public.project_financials DROP CONSTRAINT IF EXISTS project_financials_currency_iso;
ALTER TABLE public.project_financials ADD CONSTRAINT project_financials_currency_iso CHECK (currency ~ '^[A-Z]{3}$');

-- Company settings: default hourly rate and default currency
ALTER TABLE public.app_settings
  ALTER COLUMN default_hourly_rate TYPE numeric(14,2),
  ALTER COLUMN currency SET DEFAULT 'INR';
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_currency_iso;
-- Only the untouched default row still says USD; a currency someone chose is kept.
UPDATE public.app_settings SET currency = 'INR' WHERE currency = 'USD' AND updated_by IS NULL;
UPDATE public.app_settings SET currency = upper(currency) WHERE currency <> upper(currency);
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_currency_iso CHECK (currency ~ '^[A-Z]{3}$');
