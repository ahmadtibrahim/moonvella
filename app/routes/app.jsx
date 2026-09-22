import "../styles/moonvilla.css";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { BLOCKED_MESSAGE, resolveSellerContext } from "../services/seller.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  /**
   * Whether this store is blocked is resolved HERE, in the layout, rather than
   * on each page. A blocked store is owed the sentence that explains what has
   * happened to its account, and the way that goes wrong is quietly: somebody
   * adds a page that renders a different empty state, or no empty state, and
   * the one screen the store can reach is the one that does not say why. The
   * layout is the only place every page passes through.
   *
   * Deliberately not wrapped in a try/catch. If the seller context cannot be
   * read then every page under this layout is about to fail in its own loader
   * anyway, and an error boundary is a more honest answer than a banner that
   * silently does not appear.
   */
  const context = await resolveSellerContext(session.shop);
  const blocked = context.access === "BLOCKED";

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", blocked, blockedMessage: BLOCKED_MESSAGE };
};

export default function App() {
  const { apiKey, blocked, blockedMessage } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app/application">Application</s-link>
        <s-link href="/app/status">Status</s-link>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/catalog">Product Catalog</s-link>
        <s-link href="/app/products">My Products</s-link>
        <s-link href="/app/orders">Orders</s-link>
        <s-link href="/app/billing">Billing</s-link>
        <s-link href="/app/shipping">Shipping</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      {blocked && (
        <div
          role="alert"
          style={{
            margin: "1rem",
            padding: "1rem 1.25rem",
            borderRadius: "0.5rem",
            border: "1px solid #fecaca",
            background: "#fef2f2",
            color: "#7f1d1d",
          }}
        >
          <strong style={{ display: "block", marginBottom: "0.25rem" }}>
            Access blocked
          </strong>
          {/* The sentence is the loader's, and the same constant the rest of
              the app uses — one string, so no two screens can disagree. */}
          <span>{blockedMessage}</span>
        </div>
      )}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
