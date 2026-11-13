-- The bell's sound: a member hears a short chime when a notification arrives, unless they turn it off.
-- Schema only: a column with a constant default is a catalogue change, no row is rewritten.
ALTER TABLE "workspace_members" ADD COLUMN "notify_sound" BOOLEAN NOT NULL DEFAULT true;
