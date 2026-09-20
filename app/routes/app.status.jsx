import { Link, useLoaderData, useNavigate } from "react-router";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (!url.searchParams.get("shop")) {
    return { status: null, submittedAt: null };
  }

  const { authenticate } = await import("../shopify.server");
  const { session } = await authenticate.admin(request);
  const { prisma } = await import("../db.server");

  const application = await prisma.merchantApplication.findUnique({
    where: { shopDomain: session.shop },
    select: { status: true, submittedAt: true },
  });

  if (!application) {
    return { status: null, submittedAt: null };
  }

  return {
    status: application.status.toLowerCase(),
    submittedAt: application.submittedAt
      ? application.submittedAt.toISOString()
      : null,
  };
};

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
  const { status, submittedAt } = useLoaderData();
  const navigate = useNavigate();
  const applicationStatus = status || "pending";
  const isApproved = applicationStatus === "approved";
  const submittedLabel = submittedAt
    ? `Submitted on ${new Date(submittedAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })}`
    : "Not yet submitted";

  const dynamicReviewStages = [
    { id: "connected", label: "Shopify store connected", status: "completed" },
    { id: "contact", label: "Contact information received", status: "completed" },
    { id: "website", label: "Website/store review", status: applicationStatus === "pending" ? "in-progress" : "completed" },
    { id: "sales", label: "Shopify sales review", status: applicationStatus === "pending" ? "pending" : "completed" },
    { id: "fit", label: "Product category fit", status: applicationStatus === "pending" ? "pending" : "completed" },
    { id: "approval", label: "Final approval", status: isApproved ? "completed" : "pending" },
  ];

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
                      {stage.status === 'completed' && 'Completed on January 15, 2025'}
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
            ) : (
              <>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔒</div>
                <h3 className="mv-section-title" style={{ marginBottom: '0.5rem' }}>Catalog access pending approval</h3>
                <p className="mv-page-subtitle" style={{ maxWidth: '500px', margin: '0 auto 1.5rem' }}>
                  Your product catalog preview is available, but wholesale pricing and import tools unlock after approval.
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

        {!isApproved && (
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
      </div>
    </s-page>
  );
}