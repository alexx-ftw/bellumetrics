import assert from "node:assert/strict";
import test from "node:test";
import {parseAgentDecision} from "../lib/curation/contracts.mjs";
import {resolveConsensus} from "../lib/curation/consensus.mjs";
function decision(slug="ismailia-b") {
  return {action:"approve_battle", evidence:[{citation:"Source"}],reason:"Verified",
    dataRevision:"v1",promptVersion:"proposer-v1",canonicalMutation:{
      action:"approve_battle",battle:{ref:{type:"battle",id:"war-atlas:ismailia_b"},slug,title:"Ismailia",startYear:1952,outcome:"defeat"},
      commanderRefs:[{type:"commander",id:"wikidata:Q1"},{type:"commander",id:"wikidata:Q2"}]
    }};
}
test("export suffix differences normalize before persistence without changing source references",()=>{
 const a=decision("ismailia"),b=decision();
 assert.equal(resolveConsensus(a,b).kind,"execute");
 assert.equal(parseAgentDecision(a).canonicalMutation.battle.slug,"ismailia-b");
 assert.equal(a.canonicalMutation.battle.slug,"ismailia");
 assert.equal(parseAgentDecision(a).canonicalMutation.battle.ref.id,"war-atlas:ismailia_b");
 b.canonicalMutation.battle.startYear=1951;
 assert.equal(resolveConsensus(a,b).reason,"mutation_disagreement");
});
test("participant proposal aligns identities and sides and rejects arbitrary fields",()=>{
 const d=decision();
 d.canonicalMutation.participants=d.canonicalMutation.commanderRefs.map((ref,i)=>({ref,side:i?"B":"A"}));
 assert.equal(parseAgentDecision(d).canonicalMutation.participants.length,2);
 const other=structuredClone(d);other.canonicalMutation.participants[0].side="C";
 assert.equal(resolveConsensus(d,other).reason,"mutation_disagreement");
 d.canonicalMutation.participants[0].ref={type:"commander",id:"wikidata:Q3"};
 assert.throws(()=>parseAgentDecision(d),/match/);
});
