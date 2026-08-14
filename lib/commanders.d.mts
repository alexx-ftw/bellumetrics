export type RatingMode = "historical" | "adjusted" | "tactical" | "strategic";
export interface Commander { id:string; name:string; shortName:string; nation:string; years:string; era:string; domain:string; confidence:number; sources:number; ratings:Record<RatingMode,number>; summary:string }
export interface RankedCommander extends Commander { score:number }
export interface Battle { id:string; name:string; year:number; a:string; b:string; outcome:string; confidence:number }
export const commanders:Commander[]; export const battles:Battle[];
export function rankCommanders(mode?:RatingMode):RankedCommander[];
export function shortestPath(startId:string,endId:string):Commander[]|null;
export function getCommander(id:string):Commander|null;
export function battlesForCommander(id:string):Battle[];
