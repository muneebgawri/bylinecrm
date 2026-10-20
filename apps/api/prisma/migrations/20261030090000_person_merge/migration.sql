-- Person dedupe: a person merged into another is trashed and points at the person it was merged into.
ALTER TABLE "people" ADD COLUMN "merged_into_id" UUID;

ALTER TABLE "people" ADD CONSTRAINT "people_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;
