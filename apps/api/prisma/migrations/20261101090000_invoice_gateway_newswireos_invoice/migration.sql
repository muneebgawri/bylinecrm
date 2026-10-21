-- A NewswireOS invoice number (`INV-202610-000067`, `2GBMDHSF-0002`) as an invoice's reference: NewswireOS resolves
-- it to the payment behind it.
ALTER TYPE "invoice_gateway" ADD VALUE IF NOT EXISTS 'newswireos_invoice';
