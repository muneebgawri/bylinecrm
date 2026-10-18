-- #196: a member's own Slotline API key (encrypted; its last four shown), and the event type their signature's
-- "Book a quick meeting" opens — picked from every event type on their Slotline account, hidden ones too.

-- AlterTable
ALTER TABLE "workspace_members" ADD COLUMN     "slotline_api_key_ciphertext" TEXT,
ADD COLUMN     "slotline_api_key_last4" TEXT,
ADD COLUMN     "slotline_event_slug" TEXT,
ADD COLUMN     "slotline_event_title" TEXT;

-- A key comes with its last four; an event type is a path segment, and has a title.
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_slotline_key_shape"
    CHECK (("slotline_api_key_ciphertext" IS NULL) = ("slotline_api_key_last4" IS NULL));
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_slotline_event_shape"
    CHECK (("slotline_event_slug" IS NULL) = ("slotline_event_title" IS NULL)
        AND ("slotline_event_slug" IS NULL OR "slotline_event_slug" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'));
