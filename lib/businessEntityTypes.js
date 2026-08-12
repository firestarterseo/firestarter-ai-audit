// The full list of schema.org business-entity @types this project's Schema
// & Structure checker (checker.js) recognizes and scores, and the Schema
// Generator (schemaGenerator.js) is allowed to generate. Split into its own
// zero-dependency file (no `fetch`, no Node-only APIs) so it can be
// imported directly by a Client Component -- the schema-type dropdown in
// SchemaGenerator.js -- without pulling checker.js's live-fetch scoring
// logic into the browser bundle. checker.js still re-exports this same
// array (imported from here, not redefined) so existing importers keep
// working unchanged.
const BUSINESS_ENTITY_TYPES = [
  'LocalBusiness', 'Organization', 'AccountingService', 'ProfessionalService',
  'Attorney', 'Dentist', 'Physician', 'Restaurant', 'Store', 'HomeAndConstructionBusiness',
  'LegalService', 'FinancialService', 'InsuranceAgency', 'RealEstateAgent',
  'AutoRepair', 'MedicalBusiness', 'Plumber', 'Electrician', 'HVACBusiness',
  'RoofingContractor', 'GeneralContractor'
]

module.exports = { BUSINESS_ENTITY_TYPES }
