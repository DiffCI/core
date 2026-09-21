import { readFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { contribution, type AdapterContext, type AdapterContribution, type RepositoryAdapter } from "./types.js";

interface Pom { path:string; dir:string; groupId?:string; artifactId?:string; modules:string[]; dependencies:Array<{groupId:string;artifactId:string}>; }

function tags(xml:string, name:string): string[] {
  const re=new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`,"g"); const out:string[]=[]; let m:RegExpExecArray|null;
  while((m=re.exec(xml))) out.push((m[1]??"").trim()); return out;
}
function first(xml:string,name:string):string|undefined { return tags(xml,name)[0]; }
function parsePom(path:string, xml:string):Pom {
  const dir=posix.dirname(path)==="."?"":posix.dirname(path);
  const parent=first(xml,"parent")??"";
  const own=xml.replace(/<parent\b[^>]*>[\s\S]*?<\/parent>/,"");
  const deps=tags(xml,"dependency").map(x=>({groupId:first(x,"groupId")??"",artifactId:first(x,"artifactId")??""})).filter(x=>x.artifactId);
  return {path,dir,groupId:first(own,"groupId")??first(parent,"groupId"),artifactId:first(own,"artifactId"),modules:tags(first(xml,"modules")??"","module"),dependencies:deps};
}
function under(dir:string,path:string){return !dir||path===dir||path.startsWith(dir+"/");}
function owningPom(poms:Pom[], file:string):Pom|undefined { return poms.filter(p=>under(p.dir,file)).sort((a,b)=>b.dir.length-a.dir.length)[0]; }
function javaFiles(context:AdapterContext, poms:Pom[], pom:Pom){return context.files.filter(f=>owningPom(poms,f)===pom&&/\/src\/(?:main|test)\/(?:java|kotlin)\/.*\.(?:java|kt)$/.test("/"+f));}
function isTest(path:string){return /\/src\/test\/(?:java|kotlin)\//.test("/"+path)&&/(?:Test|Tests|TestCase|IT)\.(?:java|kt)$/.test(path);}

export function analyzeMaven(context:AdapterContext):AdapterContribution {
  const r=contribution(mavenAdapter);
  const poms=context.files.filter(f=>f==="pom.xml"||f.endsWith("/pom.xml")).map(path=>parsePom(path,readFileSync(context.repoPath+"/"+path,"utf8")));
  if(!poms.length){r.blockers.push("Maven analysis found no pom.xml");return r;}
  const byGA=new Map(poms.filter(p=>p.artifactId).map(p=>[`${p.groupId??""}:${p.artifactId}`,p]));
  const members=new Map<Pom,string[]>(), anchors=new Map<Pom,string>();
  for(const p of poms){const files=javaFiles(context,poms,p); if(!files.length) continue; members.set(p,files); anchors.set(p,files[0]!); r.sourcePaths.push(...files); for(const f of files) if(isTest(f)){r.testFiles.push(f);r.testPackages[f]=p.dir||".";}}
  for(const [p,files] of members){const a=anchors.get(p)!; for(const f of files) if(f!==a) r.edges.push({from:a,to:f,kind:"import"},{from:f,to:a,kind:"import"});
    for(const d of p.dependencies){const target=byGA.get(`${d.groupId}:${d.artifactId}`)??[...poms].find(x=>x.artifactId===d.artifactId); const ta=target&&anchors.get(target); if(ta&&ta!==a) r.edges.push({from:a,to:ta,kind:"import"});}
  }
  if(!r.sourcePaths.length) r.blockers.push("Maven reactor contains no Java sources");
  return r;
}
export const mavenAdapter:RepositoryAdapter={id:"maven",version:"1",kind:"language",detect:({files})=>files.includes("pom.xml")&&files.some(f=>f.endsWith(".java")||f.endsWith(".kt")),analyze:analyzeMaven};
