import { actor } from "@sdk";

type Item = { id: string; price: number };
type State = { items: Item[]; total: number };

export default actor<State>({
  state: { items: [], total: 0 },
  handlers: {
    addItem(ctx, item: Item) {
      ctx.state.items.push(item);
      ctx.state.total += item.price;
    },
    removeItem(ctx, { itemId }: { itemId: string }) {
      const index = ctx.state.items.findIndex((i) => i.id === itemId);
      const item = index !== -1 ? ctx.state.items[index] : undefined;
      if (index !== -1 && item !== undefined) {
        ctx.state.total -= item.price;
        ctx.state.items.splice(index, 1);
      }
    },
    getState(ctx) {
      return ctx.state;
    },
  },
});
