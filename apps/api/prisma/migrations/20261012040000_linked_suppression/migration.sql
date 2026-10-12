-- #114: a suppression entry is a linked thing on the timeline — an address of a person put on or lifted
-- from the list leaves a `linked-suppression.*` entry on that person.
ALTER TYPE "linked_object" ADD VALUE 'suppression';
