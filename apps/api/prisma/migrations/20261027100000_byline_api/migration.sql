-- BYL-2 (#208): the CRM asks BylineAI for enrichment and verification with an API key. The link may now hold only
-- the API side; a workspace with no webhook secret refuses deliveries as an unlinked one does.
ALTER TABLE "byline_settings" ALTER COLUMN "secret_ciphertext" DROP NOT NULL;
ALTER TABLE "byline_settings" ADD COLUMN "base_url" TEXT,
ADD COLUMN "api_key_ciphertext" TEXT,
ADD COLUMN "verify_with_byline" BOOLEAN NOT NULL DEFAULT false;

-- Shape: an origin, and a key with it; something linked.
ALTER TABLE "byline_settings" ADD CONSTRAINT "byline_settings_api_shape"
    CHECK (("base_url" IS NULL) = ("api_key_ciphertext" IS NULL) AND ("base_url" IS NULL OR "base_url" ~ '^https?://[^/?#]+$'));
ALTER TABLE "byline_settings" ADD CONSTRAINT "byline_settings_linked"
    CHECK ("secret_ciphertext" IS NOT NULL OR "api_key_ciphertext" IS NOT NULL);
