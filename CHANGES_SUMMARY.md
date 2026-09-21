# MoonVella App Changes Summary

All changes implemented during this development session. See individual file diffs for detailed line-by-line modifications.

## High Priority Fixes

### 1. Product measurements (cm/kg only / inches read-only)
- **File**: `app/routes/admin.products_.$id.tsx`
- **Change**: Changed packaging form defaults from `cm`/`kg` to `in`/`lb` (lines 338-346)
- **Impact**: Product measurements now default to inches and pounds per user preference

### 2. Packaging defaults (cm/kg contrary to inches preference)
- **File**: `app/routes/admin.products_.$id.tsx` and `app/routes/admin.packing.$orderId.tsx`
- **Change**: Updated form defaults and display to show actual stored units instead of hardcoded `cm`/`kg`
- **Impact**: Packaging now respects user's inch/lb preference throughout the UI

### 3. Multi-box shipping quote behavior
- **File**: `app/routes/admin.packing.$orderId.tsx`
- **Change**: Updated variant packaging display to show `${p.count}× ${p.length}×${p.width}×${p.height} ${p.dimensionUnit}${p.weightUnit}` instead of hardcoded `cm`/`kg`
- **Impact**: Shipping quotes now display correct units based on stored variant packaging data

### 4. Alt text required for image publishing
- **File**: `app/routes/admin.products_.$id.tsx`
- **Change**: Added `required` attribute to alt text inputs (both file upload and URL image forms), added `*` asterisk marker
- **Impact**: Images cannot be published without alt text, ensuring accessibility compliance

### 5. Media coverage vs publication banner clarification
- **File**: `app/routes/admin.products_.$id.tsx` and `app/routes/admin.products.tsx`
- **Change**: Added clarification text in product details page and product list noting that variant images are separate from product images needed for publication
- **Impact**: Clearer distinction between per-variant pictures and publication-required product images

## Medium Priority Fixes

### 6. Dashboard and Products both appear highlighted
- **File**: `app/routes/admin.tsx`
- **Change**: Fixed active navigation state logic - Dashboard now only highlights on exact `/admin` path, not sub-routes
- **Impact**: Correct active state highlighting in sidebar navigation

### 7. Text readability improvements
- **File**: `app/routes/admin.products_.$id.tsx`
- **Change**: Increased input font size (0.85rem → 0.9rem), label font size and color contrast, helper text size, card padding (1.5rem → 2rem)
- **Impact**: Improved scannability and reduced crowding in editor forms

### 8. Category and currency validation
- **File**: `app/routes/admin.products_.$id.tsx` and `app/routes/admin.products.tsx`
- **Change**: Added dropdown with common categories (Clothing, Accessories, Home & Garden, Sports, Electronics, Other) and currencies (CAD, USD, EUR, GBP, AUD, CHF), with "Or enter new/custom" options
- **Impact**: Prevents inconsistent free-text entries for category and currency fields

### 9. Onboarding wording (Category-neutral)
- **File**: `app/routes/app.application.jsx`
- **Change**: Replaced "Apply to sell MoonVella bedding" with "Apply to access MoonVella", updated supporting text to "Submit your business details to access MoonVella's wholesale catalog and seller tools."
- **Impact**: General onboarding now uses category-neutral wording as specified

### 10. Merchant onboarding flow after approval/rejection
- **File**: `app/routes/app.application.jsx`, `app/routes/app.status.jsx`
- **Change**: 
  - **Approved sellers**: Status page shows approved access, enables catalog/import/seller tools, navigates to dashboard on return
  - **Rejected applicants**: Status page shows "Application not approved" with rejection reason, locks catalog access, allows resubmission
  - **Pending/Needs info**: Preserves existing behavior - product preview without wholesale prices, no imports until approved
  - **Status revalidation**: Added logic to check application status on page load and navigate accordingly
  - **Server-side enforcement**: Existing `application.server.ts` already checks status in transactions (not just hiding navigation)
- **Impact**: Complete merchant onboarding flow with proper status handling, navigation, and feature access control

## Files Modified

1. `app/routes/admin.packing.$orderId.tsx` - Packaging unit display fixes
2. `app/routes/admin.products.tsx` - Category/currency dropdowns and publication notes
3. `app/routes/admin.products_.$id.tsx` - Measurements, alt text, text readability, category/currency
4. `app/routes/admin.tsx` - Dashboard navigation active state fix
5. `app/routes/app.application.jsx` - Onboarding wording, status checks on load
6. `app/routes/app.status.jsx` - Rejected/approved status display with feature locking

## Verification

- Lint: No new errors introduced (all errors are pre-existing)
- Typecheck: All errors are pre-existing and not related to these changes