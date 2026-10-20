-- INV-1: link NewswireOS before its hook secret exists (NewswireOS mints the secret only once it has the
-- hook URL that linking makes). Deliveries are refused while it is null.
ALTER TABLE "newswireos_settings" ALTER COLUMN "secret_ciphertext" DROP NOT NULL;
