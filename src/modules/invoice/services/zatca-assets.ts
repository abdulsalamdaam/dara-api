/**
 * ZATCA static assets baked into source so we don't have to ship a separate
 * `assets/` directory and keep the dist/ layout in sync. These are small,
 * stable, and version-locked to the ZATCA Phase 2 spec.
 */

/**
 * The hash transform XSL ZATCA mandates for invoice canonicalization.
 * Strips UBLExtensions, cac:Signature, and AdditionalDocumentReference[QR],
 * then xmllint --c14n11 + SHA-256 produces the binding "invoice hash".
 */
export const ZATCA_HASH_XSL = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
                xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
                xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
                xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
                xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <xsl:output method="xml" indent="no" encoding="UTF-8"/>
  <xsl:template match="node() | @*">
    <xsl:copy>
      <xsl:apply-templates select="node() | @*"/>
    </xsl:copy>
  </xsl:template>
  <xsl:template match="//*[local-name()='Invoice']/*[local-name()='UBLExtensions']"/>
  <xsl:template match="//*[local-name()='Invoice']/*[local-name()='Signature']"/>
  <xsl:template match="//*[local-name()='Invoice']/*[local-name()='AdditionalDocumentReference'][cbc:ID[normalize-space(text())='QR']]"/>
</xsl:stylesheet>
`;

/**
 * OpenSSL CSR config template for ZATCA EGS units. The placeholders
 * ({TEMPLATE_NAME}, {SERIAL_NUMBER}, etc.) are filled in by CsrService.
 *
 * The exact OID layout (subjectAltName: dirName:alt_names containing
 * SN/UID/title/registeredAddress/businessCategory) is mandated by ZATCA's
 * implementation guide — do not alter.
 */
export const ZATCA_CSR_TEMPLATE = `oid_section = OIDs

[ OIDs ]
certificateTemplateName = 1.3.6.1.4.1.311.20.2

[ req ]
prompt              = no
# Without this, openssl reads the already-UTF-8 Arabic below as Latin-1 and
# re-encodes it, so every byte becomes two. The seller's name went into the
# certificate as "Ø§Ø¨Ø±Ø§Ù‡ÙŠÙ…" and that is what ZATCA's Fatoora portal
# displays, because the portal shows the certificate subject verbatim.
utf8                = yes
default_md          = sha256
req_extensions      = req_ext
distinguished_name  = dn

[ dn ]
C  = {COUNTRY}
OU = {ORG_UNIT}
O  = {ORG_NAME}
CN = {COMMON_NAME}

[ req_ext ]
1.3.6.1.4.1.311.20.2 = ASN1:PRINTABLESTRING:{TEMPLATE_NAME}
subjectAltName       = dirName:alt_names

[ alt_names ]
SN                = {SERIAL_NUMBER}
UID               = {ORG_IDENTIFIER}
title             = {INVOICE_TYPE}
registeredAddress = {LOCATION_ADDRESS}
businessCategory  = {INDUSTRY_CATEGORY}
`;
