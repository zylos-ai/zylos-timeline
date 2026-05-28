import PrivacyPolicy, { metadata } from "../../[locale]/privacy/page";

const params = Promise.resolve({ locale: "en" });

export { metadata };

export default function Page() {
  return <PrivacyPolicy params={params} />;
}
