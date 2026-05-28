import ResearchPage from "../../[locale]/research/page";

const params = Promise.resolve({ locale: "en" });

export default function Page() {
  return <ResearchPage params={params} />;
}
