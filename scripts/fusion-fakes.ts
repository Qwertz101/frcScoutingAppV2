export const fake = {
  request: async (_request: any): Promise<any> => ({ data: [], error: null }),
};
export default {
  from(table: string) {
    const request: any = { table };
    const query: any = {
      select() { return query; }, order() { return query; },
      like(_column: string, pattern: string) { request.pattern = pattern; return query; },
      range(from: number, to: number) { Object.assign(request, { from, to }); return query; },
      upsert(rows: any[]) { request.rows = rows; return query; },
      abortSignal() { return fake.request(request); },
    };
    return query;
  },
};
export const getSupabaseInfo = () => ({});
