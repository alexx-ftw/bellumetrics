const ISSUE_TITLE = "Supabase automation failure";
const ISSUE_LABEL = "automation";

export async function reportSupabaseSync({ github, context, syncResult }) {
  const { owner, repo } = context.repo;
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  const issues = await github.paginate(
    github.rest.issues.listForRepo,
    {
      owner,
      repo,
      state: "open",
      labels: ISSUE_LABEL,
      per_page: 100,
    },
  );
  const issue = issues.find(
    (candidate) => !candidate.pull_request && candidate.title === ISSUE_TITLE,
  );

  if (syncResult === "failure") {
    try {
      await github.rest.issues.getLabel({ owner, repo, name: ISSUE_LABEL });
    } catch (error) {
      if (error.status !== 404) throw error;
      await github.rest.issues.createLabel({
        owner,
        repo,
        name: ISSUE_LABEL,
        color: "B60205",
      });
    }

    const body = `Supabase synchronization failed in [workflow run ${context.runId}](${runUrl}).`;
    if (issue) {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body,
      });
    } else {
      await github.rest.issues.create({
        owner,
        repo,
        title: ISSUE_TITLE,
        labels: [ISSUE_LABEL],
        body,
      });
    }
  } else if (syncResult === "success" && issue) {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issue.number,
      body: `Supabase synchronization recovered in [workflow run ${context.runId}](${runUrl}).`,
    });
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: issue.number,
      state: "closed",
    });
  }
}
