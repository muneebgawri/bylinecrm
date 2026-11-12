-- A shared (pool or service) Gmail mailbox may sync through the workspace's service account too (#225):
-- the delegation shape no longer requires a personal mailbox. Still Gmail, still no refresh token of its own.
-- The mailboxes table is small; validating the constraint is a quick scan.
ALTER TABLE "mailboxes" DROP CONSTRAINT "mailboxes_delegation_shape";
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_delegation_shape"
    CHECK ("credential_source" = 'oauth'
        OR ("transport" = 'gmail' AND "refresh_token_ciphertext" IS NULL));

-- Moving a shared mailbox onto delegation is audited.
ALTER TABLE "google_workspace_delegation_audit" DROP CONSTRAINT "google_workspace_delegation_audit_action";
ALTER TABLE "google_workspace_delegation_audit" ADD CONSTRAINT "google_workspace_delegation_audit_action"
    CHECK ("action" IN ('key_set', 'key_removed', 'domains_changed', 'member_excluded', 'member_included',
                        'sync_started', 'sync_failed', 'shared_delegated'));
