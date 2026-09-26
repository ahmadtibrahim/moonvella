import "../styles/moonvilla.css";
import PropTypes from "prop-types";
import { useEffect } from "react";
import {
  isRouteErrorResponse,
  Outlet,
  useLoaderData,
  useRevalidator,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { resolveSellerContext } from "../services/seller.server";
import { CurrencyProvider, CurrencyToggle } from "../components/CurrencyDisplay";
// From the shared module, not from seller.server: the error boundary below
// renders in the browser, and a `.server` import reaching client code fails the
// build rather than the page.
import { BLOCKED_MESSAGE } from "../utils/blockedMessage";

/**
 * How often an open page re-reads the seller's access state, in milliseconds.
 *
 * The owner can approve, deactivate or block a store while that store has the
 * app open, and the store should not have to guess to find out. Thirty seconds
 * is a compromise: often enough that an approval feels immediate, rare enough
 * that a forgotten tab is not a load generator. The poll is a HEAD-of-state
 * check only — it revalidates the layout loader, which reads two indexed rows.
 */
const ACCESS_POLL_MS = 30_000;

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
   * This is the SECOND line of defence, not the first. React Router runs parent
   * and child loaders in parallel, so a blocked store's page loader would still
   * have fetched its rows before this decides anything — every route therefore
   * calls `requireMerchantAccess` itself. What the layout adds is that no route
   * can render the wrong thing even if one of them forgets.
   *
   * Deliberately not wrapped in a try/catch. If the seller context cannot be
   * read then every page under this layout is about to fail in its own loader
   * anyway, and an error boundary is a more honest answer than a banner that
   * silently does not appear.
   */
  const context = await resolveSellerContext(session.shop);
  const blocked = context.access === "BLOCKED";

  // The navigation is a function of access, not a fixed list. Approval removes
  // Apply; a rejection keeps it, because reapplying is what that state is for.
  const showApplication =
    context.access !== "APPROVED" && context.access !== "BLOCKED";
  const showBusiness = context.access === "APPROVED";
  const showOrders = context.canViewOrders;

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    blocked,
    blockedMessage: BLOCKED_MESSAGE,
    showApplication,
    showBusiness,
    showOrders,
  };
};

export default function App() {
  const {
    apiKey,
    blocked,
    blockedMessage,
    showApplication,
    showBusiness,
    showOrders,
  } = useLoaderData();
  const revalidator = useRevalidator();

  /**
   * Re-read the access state on a timer and whenever the tab is brought back
   * into view, so an owner's decision arrives without the merchant reloading.
   *
   * The new state is not announced with a toast: the page itself changes — a
   * blocked store's screen is replaced, an approval unlocks navigation — and a
   * message on top of that would be narrating what the reader can already see.
   */
  useEffect(() => {
    if (blocked) return;
    const tick = () => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    };
    const timer = setInterval(tick, ACCESS_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [blocked, revalidator]);

  /**
   * A blocked store gets the sentence and nothing else: no navigation to
   * anywhere, no catalogue shell, no empty tables that hint at what used to be
   * here. Rendering the outlet would hand the page back the moment a route
   * forgot its own guard.
   */
  if (blocked) {
    return <BlockedScreen apiKey={apiKey} message={blockedMessage} />;
  }

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        {showApplication && <s-link href="/app/application">Application</s-link>}
        <s-link href="/app/status">Status</s-link>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/catalog">Product Catalog</s-link>
        {showBusiness && <s-link href="/app/products">My Products</s-link>}
        {showOrders && <s-link href="/app/orders">Orders</s-link>}
        {showBusiness && <s-link href="/app/billing">Billing</s-link>}
        <s-link href="/app/shipping">Shipping</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      {/*
        Every price under this layout is rendered through the provider, so a
        seller who reads in US dollars reads the whole app that way. It sits
        above the outlet rather than inside a page because the choice is about
        the reader, not about the screen they happen to be on.
      */}
      <CurrencyProvider>
        <CurrencyToggle />
        <Outlet />
      </CurrencyProvider>
    </AppProvider>
  );
}

/**
 * The one screen a blocked store is allowed to see.
 *
 * `apiKey` is optional because this is also rendered from the error boundary,
 * where the layout loader never ran and there is no key to read. Losing App
 * Bridge on that path is the right trade: the block screen has no navigation to
 * initialise and nothing to navigate to.
 */
function BlockedScreen({ apiKey, message }) {
  const card = (
    <div className="mv-container" style={{ padding: "3rem 1rem" }}>
      <div
        role="alert"
        className="mv-section-card"
        style={{
          maxWidth: "32rem",
          margin: "0 auto",
          textAlign: "center",
          border: "1px solid #fecaca",
          background: "#fef2f2",
          color: "#7f1d1d",
        }}
      >
        {/* One string, from one constant, so no two screens can disagree. */}
        <p style={{ margin: 0, fontSize: "1rem" }}>{message}</p>
      </div>
    </div>
  );

  if (!apiKey) return card;
  return (
    <AppProvider embedded apiKey={apiKey}>
      {card}
    </AppProvider>
  );
}

BlockedScreen.propTypes = {
  // Absent on the error-boundary path, where the layout loader is what failed.
  apiKey: PropTypes.string,
  message: PropTypes.string.isRequired,
};

/**
 * Whether a thrown response is the Shopify library's bootstrap page.
 *
 * The library builds that body itself — one App Bridge <script> carrying the
 * app's public client id and no text — so it is matched by shape, not by the
 * status alone. Both parts are required: a body that merely names the script
 * file could be a real error whose text happens to include an asset path, and
 * styling that as a harmless notice would hide the failure it was reporting.
 */
function isAppBridgeBootstrap(error) {
  return (
    isRouteErrorResponse(error) &&
    typeof error.data === "string" &&
    error.data.includes("data-api-key=") &&
    error.data.includes("app-bridge.js")
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  const error = useRouteError();

  /*
   * When a route's own guard refuses a blocked store, the refusal arrives here
   * as a 403 carrying the block sentence — and the boundary would otherwise
   * replace the block card above with a generic error page that happens to
   * contain the same words. Rendering the card instead keeps the promise that a
   * blocked store sees one screen and nothing else, whichever code path it
   * reached the app by.
   *
   * Anything else — a real crash, a 404, an ordinary refusal such as a pending
   * seller asking for orders — goes to the framework boundary untouched. Those
   * are errors, and an error page is the honest answer to them.
   */
  if (
    isRouteErrorResponse(error) &&
    error.status === 403 &&
    typeof error.data === "string" &&
    error.data === BLOCKED_MESSAGE
  ) {
    // No apiKey: the layout loader is the thing that failed, so there is none.
    return <BlockedScreen message={BLOCKED_MESSAGE} />;
  }

  /*
   * The app's bootstrap page, said out loud.
   *
   * `authenticate.admin` refuses a request that carries no `shop`/`host` — a
   * URL opened from outside the Shopify admin, a bookmarked app page, a link
   * pasted into a new tab — by throwing a 200 whose body is one App Bridge
   * <script> tag. `boundary.error` renders that body and nothing else, so the
   * answer is a blank page that reports success. Every page under this layout
   * looks identical from there, which makes "the page is empty" and "the page
   * never ran" impossible to tell apart — and the second is what happened.
   *
   * The script is still rendered, and still first: inside the admin iframe it
   * is the thing that performs the top-level redirect, and removing it would
   * break the flow it belongs to. The sentence after it is what a person gets
   * when there is no iframe for it to run in.
   */
  if (isAppBridgeBootstrap(error)) {
    return (
      <div className="mv-container" style={{ padding: "3rem 1rem" }}>
        <div className="mv-section-card" style={{ maxWidth: "32rem", margin: "0 auto" }}>
          {/* eslint-disable-next-line react/no-danger */}
          <div dangerouslySetInnerHTML={{ __html: error.data }} />
          <p style={{ margin: 0, fontSize: "1rem" }}>
            MoonVella has to be opened from your Shopify admin — it reads which store is
            asking from Shopify itself, so a page opened on its own has nothing to show.
            Open it from <strong>Apps</strong> in your admin, or press <strong>Reload</strong>{" "}
            if you are already there.
          </p>
        </div>
      </div>
    );
  }

  return boundary.error(error);
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
