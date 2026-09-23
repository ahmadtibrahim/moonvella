import { Link, useLoaderData, useNavigate } from "react-router";
import { BLOCKED_MESSAGE, withMerchantAccess } from "../services/seller.server";

/**
 * The status page reads the application the seller context already resolved.
 *
 * It used to authenticate a second time and re-query the application itself,
 * which meant two sources of truth for "what state is this store in" — the
 * layout's answer and this page's answer, computed from the same row at two
 * different moments. When the owner changed a status in between, the navigation
 * and the page disagreed about it. One resolution per request removes the
 * possibility.
 */
export const loader = async ({ request }) =>
  withMerchantAccess(request, "VIEW", async (context) => {
    const application = context.application;

    return {
      // "none" is its own answer. A store that has never applied was shown
      // "Application Under Review", which is not a thing that was happening.
      status: application ? application.status.toLowerCase() : "none",
      submittedAt: application?.submittedAt
        ? application.submittedAt.toISOString()
        : null,
      access: context.access,
      blockedMessage: BLOCKED_MESSAGE,
    };
  });

const getStageConfig = (stage) => {
  switch (stage) {
    case "pending":
      return { label: "Pending Review", badge: "mv-badge-pending" };
    case "approved":
      return { label: "Approved", badge: "mv-badge-instock" };
    case "needs_info":
      return { label: "Needs Information", badge: "mv-badge-warning" };
    case "rejected":
      return { label: "Rejected", badge: "mv-badge-danger" };
    case "suspended":
      return { label: "Suspended", badge: "mv-badge-danger" };
    // Without this the page falls through to "Pending Review", which would tell
    // a blocked store that its application is still being looked at.
    case "blocked":
      return { label: "Blocked", badge: "mv-badge-danger" };
    // Deactivated is a withdrawn approval, not a pending one: the owner turned
    // access off and the store may apply again. Falling through to "Pending
    // Review" would read as though nothing had happened.
    case "deactivated":
      return { label: "Access deactivated", badge: "mv-badge-warning" };
    case "none":
      return { label: "Not yet submitted", badge: "mv-badge-pending" };
    default:
      return { label: "Pending Review", badge: "mv-badge-pending" };
  }
};

const getStatusConfig = (status) => {
  switch (status) {
    case "completed":
      return { badge: "mv-badge-instock", icon: "✓", text: "Completed" };
    case "in-progress":
      return { badge: "mv-badge-processing", icon: "⟳", text: "In Review" };
    default:
      return { badge: "mv-badge-pending", icon: "○", text: "Pending" };
  }
};

export default function StatusPage() {
  const { status, submittedAt, blockedMessage } = useLoaderData();
  const navigate = useNavigate();
  const applicationStatus = status || "pending";
  const isApproved = applicationStatus === "approved";
  const isRejected = applicationStatus === "rejected";
  const isBlocked = applicationStatus === "blocked";
  // An application that needs more information is still in review — it just has
  // a question outstanding. Grouping it with "pending" is what makes the review
  // checklist show the truth instead of reporting every stage as finished.
  const isNeedsInfo = applicationStatus === "needs_info";
  const isPending = applicationStatus === "pending" || isNeedsInfo;
  const isDeactivated = applicationStatus === "deactivated";
  const isNotStarted = applicationStatus === "none";

  /**
   * The only date this page knows is the one the application recorded. It used
   * to print "Completed on January 15, 2025" against every finished stage,
   * which was a literal in the template — a date that was never true for any
   * store. A stage now says whether it is done and nothing more.
   */
  const submittedLabel = submittedAt
    ? `Submitted on ${new Date(submittedAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })}`
    : "Not yet submitted";

  // Review stages follow the real status. A store still waiting is at the first
  // stage; anything decided has been through all of them.
  const reviewStatus = isPending ? "in-progress" : "completed";
  const dynamicReviewStages = [
    { id: "connected", label: "Shopify store connected", status: "completed" },
    {
      id: "contact",
      label: "Contact information received",
      status: submittedAt ? "completed" : "pending",
    },
    { id: "website", label: "Website/store review", status: reviewStatus },
    {
      id: "sales",
      label: "Shopify sales review",
      status: isPending ? "pending" : "completed",
    },
    {
      id: "fit",
      label: "Product category fit",
      status: isPending ? "pending" : "completed",
    },
    {
      id: "approval",
      label: "Final approval",
      status: isApproved ? "completed" : "pending",
    },
  ];

  const getRejectionReason = () => {
    // Fetch rejection reason from the application - best effort
    // If we can't fetch it, we'll just not display it
    return null;
  };

  return (
    <s-page heading="Application Status">
      <div className="mv-container">
        <div className="mv-page-header">
          <h2 className="mv-page-title">Application Status</h2>
          <p className="mv-page-subtitle">
            Track your MoonVella dropship partner application progress.
          </p>
        </div>

        <div className="mv-section-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
            <div>
              <h3 className="mv-page-title" style={{ fontSize: '1.5rem', marginBottom: '0.25rem' }}>MoonVella Partner Application</h3>
              <p className="mv-page-subtitle">{submittedLabel}</p>
            </div>
            <span className={`mv-badge ${getStageConfig(applicationStatus).badge}`} style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}>
              {getStageConfig(applicationStatus).label}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {dynamicReviewStages.map((stage) => {
              const config = getStatusConfig(stage.status);
              return (
                <div key={stage.id} className="mv-checklist-item" style={{ 
                  padding: '1.25rem 1.5rem', 
                  background: stage.status === 'completed' ? 'var(--background)' : 'transparent',
                  borderLeft: stage.status === 'in-progress' ? '3px solid var(--primary-color)' : 'none'
                }}>
                  <span className={`mv-checklist-badge ${stage.status === 'completed' ? 'mv-done' : stage.status === 'in-progress' ? 'mv-processing' : 'mv-pending'}`}>
                    {config.icon}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.25rem' }}>
                      <span style={{ fontWeight: '600', fontSize: '0.9375rem' }}>{stage.label}</span>
                      <span className={`mv-badge ${config.badge}`}>{config.text}</span>
                    </div>
                    <p className="mv-checklist-text" style={{ margin: 0, fontSize: '0.8125rem' }}>
                      {stage.status === 'completed' && 'Done'}
                      {stage.status === 'in-progress' && 'Under review by MoonVella team'}
                      {stage.status === 'pending' && 'Awaiting previous stage completion'}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mv-section-card">
          <h3 className="mv-section-title">Product Catalog Access</h3>
          <div className="mv-checklist-item" style={{ padding: '2rem', textAlign: 'center', background: 'var(--background)' }}>
            {isApproved ? (
              <>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✓</div>
                <h3 className="mv-section-title" style={{ marginBottom: '0.5rem' }}>Your store is approved</h3>
                <p className="mv-page-subtitle" style={{ maxWidth: '500px', margin: '0 auto 1.5rem' }}>
                  You can now view wholesale pricing and import MoonVella products.
                </p>
                <button className="mv-btn mv-btn-primary" onClick={() => navigate("/app/catalog")}>
                  View Product Catalog
                </button>
              </>
            ) : isRejected ? (
              <>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔒</div>
                <h3 className="mv-section-title" style={{ marginBottom: '0.5rem' }}>Application not approved</h3>
                <p className="mv-page-subtitle" style={{ maxWidth: '500px', margin: '0 auto 1.5rem' }}>
                  Your application was not approved for MoonVella wholesale access.
                </p>
                {getRejectionReason() && (
                  <p className="mv-page-subtitle" style={{ marginTop: '0.5rem' }}>
                    {getRejectionReason()}
                  </p>
                )}
                <button className="mv-btn mv-btn-secondary" onClick={() => navigate("/app/application")}>
                  Resubmit Application
                </button>
                <p className="mv-page-subtitle" style={{ marginTop: '1rem', fontSize: '0.875rem' }}>
                  Product catalog, wholesale pricing, and import tools remain locked.
                </p>
              </>
            ) : isBlocked ? (
              <>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔒</div>
                <h3 className="mv-section-title" style={{ marginBottom: '0.5rem' }}>Partner access blocked</h3>
                {/* Not "declined" and not "under review": the store is owed the
                    plain statement, and the one MoonVella asked for. */}
                <p
                  className="mv-page-subtitle"
                  style={{ maxWidth: '500px', margin: '0 auto 1.5rem' }}
                  role="alert"
                >
                  {blockedMessage}
                </p>
              </>
            ) : isDeactivated ? (
              <>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔒</div>
                <h3 className="mv-section-title" style={{ marginBottom: '0.5rem' }}>Seller access deactivated</h3>
                <p className="mv-page-subtitle" style={{ maxWidth: '500px', margin: '0 auto 1.5rem' }}>
                  MoonVella wholesale access for this store has been switched off. Your previous
                  orders and billing history are still on file.
                </p>
                <button className="mv-btn mv-btn-primary" onClick={() => navigate("/app/application")}>
                  Apply again
                </button>
                <p className="mv-page-subtitle" style={{ marginTop: '1rem', fontSize: '0.875rem' }}>
                  Reapplying returns the application to review and needs MoonVella approval.
                </p>
              </>
            ) : isNeedsInfo ? (
              <>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✋</div>
                <h3 className="mv-section-title" style={{ marginBottom: '0.5rem' }}>More information needed</h3>
                <p className="mv-page-subtitle" style={{ maxWidth: '500px', margin: '0 auto 1.5rem' }}>
                  MoonVella has a question about your application before it can be decided. Open
                  the application to update your details and resubmit.
                </p>
                <button className="mv-btn mv-btn-primary" onClick={() => navigate("/app/application")}>
                  Update application
                </button>
              </>
            ) : isNotStarted ? (
              <>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📝</div>
                <h3 className="mv-section-title" style={{ marginBottom: '0.5rem' }}>No application yet</h3>
                <p className="mv-page-subtitle" style={{ maxWidth: '500px', margin: '0 auto 1.5rem' }}>
                  Your store is connected but has not applied for MoonVella wholesale access.
                  Product browsing is available in the meantime.
                </p>
                <button className="mv-btn mv-btn-primary" onClick={() => navigate("/app/application")}>
                  Start an application
                </button>
              </>
            ) : (
              <>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⏳</div>
                <h3 className="mv-section-title" style={{ marginBottom: '0.5rem' }}>Application Under Review</h3>
                <p className="mv-page-subtitle" style={{ maxWidth: '500px', margin: '0 auto 1.5rem' }}>
                  Your application is being reviewed by the MoonVella team. You will be notified
                  once a decision has been made.
                </p>
                <button className="mv-btn mv-btn-secondary" onClick={() => navigate("/app/application")}>
                  View Application
                </button>
              </>
            )}
          </div>
        </div>

        {isApproved && (
          <div className="mv-section-card">
            <h3 className="mv-section-title">Next steps</h3>
            <ul className="mv-rules-list" style={{ maxWidth: '600px' }}>
              <li>Browse the <Link to="/app/catalog" style={{ color: 'var(--primary-color)', fontWeight: '600' }}>Product Catalog</Link> to view wholesale pricing</li>
              <li>Import products to your Shopify store using the <strong>Import to Store</strong> button</li>
              <li>Configure your <Link to="/app/shipping" style={{ color: 'var(--primary-color)', fontWeight: '600' }}>Shipping settings</Link></li>
              <li>Set up your <Link to="/app/settings" style={{ color: 'var(--primary-color)', fontWeight: '600' }}>Branded Packing Slip</Link></li>
              <li>Monitor orders in the <Link to="/app/orders" style={{ color: 'var(--primary-color)', fontWeight: '600' }}>Orders</Link> page</li>
            </ul>
          </div>
        )}

        {/* Only while a review is actually running. A store that has not applied,
            or whose access was turned off, is not mid-review. */}
        {isPending && (
          <div className="mv-section-card">
            <h3 className="mv-section-title">What happens next?</h3>
            <ul className="mv-rules-list" style={{ maxWidth: '600px' }}>
              <li>MoonVella team reviews your store profile and website (1-2 business days)</li>
              <li>We verify product category fit and market alignment</li>
              <li>You receive email notification once approved or if we need more information</li>
              <li>Upon approval, full catalog access unlocks automatically</li>
              <li>You can then import products and start selling immediately</li>
            </ul>
          </div>
        )}

        {isRejected && (
          <div className="mv-section-card">
            <h3 className="mv-section-title">Appeal or Resubmit</h3>
            <p className="mv-page-subtitle">
              If you believe this was an error, you may resubmit your application with updated
              business details. Contact MoonVella support for more information.
            </p>
          </div>
        )}
      </div>
    </s-page>
  );
}