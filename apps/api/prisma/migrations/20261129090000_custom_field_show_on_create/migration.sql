-- An admin picks which custom fields the "Add person" popup asks for beside the fixed ones. Expand only: a
-- column with a constant default, which the colour still serving never reads.
ALTER TABLE "custom_field_definitions" ADD COLUMN "show_on_create" BOOLEAN NOT NULL DEFAULT false;

-- Turn the PR link on in the popup, where a workspace has the field: until now the popup never asked for it.
UPDATE "custom_field_definitions" SET "show_on_create" = true WHERE "object" = 'person' AND "key" = 'pr_link';
