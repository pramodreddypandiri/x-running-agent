const { loadJSON } = require('./storage');

function buildFeedbackContext({
  feedbackPath,
  whaleFeedbackPath,
  approvalsCount = 10,
  rewritesCount = 5,
  maxLength = 200,
} = {}) {
  let ctx = '';

  if (feedbackPath) {
    const fb = loadJSON(feedbackPath, { approvals: [], rejections: [], edits: [] });
    const ra = (fb.approvals || []).slice(-approvalsCount);
    if (ra.length > 0) {
      ctx += 'COMMENTS APPROVED:\n';
      ra.forEach(a => { ctx += `- "${(a.commentText || '').substring(0, maxLength)}"\n`; });
    }
    const re = (fb.edits || []).slice(-rewritesCount);
    if (re.length > 0) {
      ctx += 'REWRITES:\n';
      re.forEach(e => { ctx += `- "${(e.editedComment || '').substring(0, maxLength)}"\n`; });
    }
  }

  if (whaleFeedbackPath) {
    const wfb = loadJSON(whaleFeedbackPath, { feedback: [] });
    const all = (wfb.feedback || []).map(f => ({
      ...f,
      kind: f.kind || (f.deleted ? 'deleted' : 'kept'),
    }));
    const approvals = all.filter(f => f.kind === 'approved').slice(-8);
    const rewrites = all.filter(f => f.kind === 'rewrite').slice(-6);
    const corrections = all.filter(f =>
      (f.kind === 'kept' || f.kind === 'deleted') && f.feedback
    ).slice(-8);

    if (approvals.length || rewrites.length || corrections.length) {
      ctx += '\nWHALE COMMENT FEEDBACK FROM USER:\n';
      approvals.forEach(f => {
        ctx += `- APPROVED on @${f.author}: "${(f.comment || '').substring(0, 120)}"\n`;
      });
      rewrites.forEach(f => {
        ctx += `- REWRITE on @${f.author}: bot said "${(f.comment || '').substring(0, 80)}" → user would say: "${(f.rewrite || '').substring(0, 160)}"\n`;
      });
      corrections.forEach(f => {
        ctx += `- ${f.kind === 'deleted' ? 'DELETED' : 'KEPT-WITH-NOTE'} on @${f.author}: "${(f.comment || '').substring(0, 60)}" → "${f.feedback}"\n`;
      });
    }
  }

  return ctx || 'No feedback yet.';
}

module.exports = { buildFeedbackContext };
