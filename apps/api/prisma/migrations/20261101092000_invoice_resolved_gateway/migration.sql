-- For a NewswireOS invoice number: the rail NewswireOS resolved it to (newswireos#647); `canonical_reference` is the
-- payment's id there, so a refund NewswireOS reports on that rail finds the invoice.
ALTER TABLE "deal_invoices" ADD COLUMN "resolved_gateway" "invoice_gateway";
