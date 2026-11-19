"use client";

import dynamic from "next/dynamic";

// The app is an interactive, signed-in dashboard: it renders on the client only.
const App = dynamic(() => import("../../App"), { ssr: false });

export function ClientApp() {
  return <App />;
}
