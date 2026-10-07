// Automatic-label stop words: a compact English list plus the unit-text template vocabulary (see p1/units.py).
const ENGLISH = `a about above after again against all am an and any are as at be because been before being below between both
but by can could did do does doing done down during each few for from further had has have having he her here hers him his how
i i'll i'm if in into is it it's its itself just let let's me more most my no nor not now of off on once only or other our ours
out over own same she should so some such than that the their theirs them then there these they this those through to too under
until up very was we were what when where which while who whom why will with would you your yours also next first still need
want make sure going see now`.split(/\s+/);
const TEMPLATE = `ran run commands command edited edit edits files file read reads checks check hit failures failure failed used use
tools tool searched search updated plan delegated subtasks small medium large rewrite long running inspect test tests lint build
typecheck vcs install format other`.split(/\s+/);
export const STOP_WORDS = [...new Set([...ENGLISH, ...TEMPLATE].filter(Boolean))];
