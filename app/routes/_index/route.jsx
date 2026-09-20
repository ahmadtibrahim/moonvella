import { redirect } from "react-router";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app/application?${url.searchParams.toString()}`);
  }

  throw redirect("/app/application");
};

export default function App() {
  return null;
}