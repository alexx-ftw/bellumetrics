import test from "node:test";
import assert from "node:assert/strict";
import {parseAgentDecisionForCase} from "../lib/curation/contracts.mjs";

const original = {source_revision:"v1",payload:{slug:"example_b",commanders:[
  {slug:"first_person",side:"A"},{slug:"second_person",side:"B"}
]}};
function approval() {
  return {action:"approve_battle",dataRevision:"v1",promptVersion:"proposer-v1",
    evidence:[{citation:"Test evidence"}],reason:"Test",canonicalMutation:{
      action:"approve_battle",battle:{ref:{type:"battle",id:"war-atlas:example_b"},slug:"example-b",title:"Example"},
      commanderRefs:original.payload.commanders.map(c=>({type:"commander",id:"war-atlas:"+c.slug}))
    }};
}
test("source references are validated against original order without repair",()=>{
  const valid=approval();
  assert.equal(parseAgentDecisionForCase(valid,original).action,"approve_battle");
  const changed=approval();changed.canonicalMutation.commanderRefs[0].id="war-atlas:first-person";
  assert.throws(()=>parseAgentDecisionForCase(changed,original),/commanderRefs/);
  assert.equal(changed.canonicalMutation.commanderRefs[0].id,"war-atlas:first-person");
  const reordered=approval();reordered.canonicalMutation.commanderRefs.reverse();
  assert.throws(()=>parseAgentDecisionForCase(reordered,original),/commanderRefs/);
  const foreign=approval();foreign.canonicalMutation.battle.ref.id="war-atlas:other_b";
  assert.throws(()=>parseAgentDecisionForCase(foreign,original),/battle.ref/);
});
test("single side requires escalation, not approval or replacement",()=>{
  const oneSide=structuredClone(original);oneSide.payload.commanders[1].side="A";
  assert.throws(()=>parseAgentDecisionForCase(approval(),oneSide),/two original sides/);
  const escalated={...approval(),action:"escalate",canonicalMutation:null};
  assert.equal(parseAgentDecisionForCase(escalated,oneSide).action,"escalate");
  assert.throws(()=>parseAgentDecisionForCase({...escalated,dataRevision:"other"},oneSide),/dataRevision/);
});
test("empty lists require explicit reviewed enrichment",()=>{
  const empty={...original,payload:{...original.payload,commanders:[]}};
  assert.throws(()=>parseAgentDecisionForCase(approval(),empty),/participants required/);
  const enriched=approval();
  enriched.canonicalMutation.participants=enriched.canonicalMutation.commanderRefs.map((ref,i)=>({ref,side:i?"B":"A"}));
  assert.equal(parseAgentDecisionForCase(enriched,empty).canonicalMutation.participants.length,2);
  assert.throws(()=>parseAgentDecisionForCase(enriched,original),/overwrite/);
});
