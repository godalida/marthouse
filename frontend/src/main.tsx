import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles/kit.css";
import "./styles/app.css";
import { ToastProvider } from "./ui";

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, retry: (n, e: any) => n < 1 && !(e?.status >= 400 && e?.status < 500) } },
});

document.documentElement.dataset.theme = "dark";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
