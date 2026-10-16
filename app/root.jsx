import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "react-router";
import { brandImageUrl } from "~/services/branding.server";

/**
 * The favicon, and nothing else.
 *
 * WHY THE ROOT HAS A LOADER AT ALL. A favicon is a `<link>` in the document
 * head, so it cannot be resolved by a component that has no data — and the head
 * belongs to the root. Two indexed reads per document request is the whole cost.
 *
 * IT FAILS SOFT, DELIBERATELY. This loader runs for every document the app
 * serves, including pages that have to render even when something else is
 * wrong. A favicon is the least important thing on any of them, so a failure to
 * resolve one returns null and the browser falls back to its own default rather
 * than the page failing to render at all.
 */
export async function loader() {
  try {
    return { iconUrl: await brandImageUrl("SQUARE") };
  } catch {
    return { iconUrl: null };
  }
}

export default function App() {
  const data = useLoaderData();
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        {/*
          The uploaded square logo, when there is one. No `type` attribute: the
          stored asset is PNG or JPEG depending on what was uploaded, and
          asserting one of the two would leave the other silently unrendered.
        */}
        {data?.iconUrl ? <link rel="icon" href={data.iconUrl} /> : null}
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
