import TermsOfService, { metadata } from "../../[locale]/terms/page";

const params = Promise.resolve({ locale: "en" });

export { metadata };

export default function Page() {
  return <TermsOfService params={params} />;
}
