import { actor } from "@sdk";

export type Item = { id: string; price: number };
export type State = { items: Item[]; total: number };
export type AddItemInput = Item;
export type RemoveItemInput = { itemId: string };
export type GetStateOutput = State;

export default actor<State>({
  state: { items: [], total: 0 },
  handlers: {
    addItem(ctx, item: AddItemInput) {
      ctx.state.items.push(item);
      ctx.state.total += item.price;
    },
    removeItem(ctx, { itemId }: RemoveItemInput) {
      const index = ctx.state.items.findIndex((i) => i.id === itemId);
      const item = index !== -1 ? ctx.state.items[index] : undefined;
      if (index !== -1 && item !== undefined) {
        ctx.state.total -= item.price;
        ctx.state.items.splice(index, 1);
      }
    },
    getState(ctx): GetStateOutput {
      return ctx.state;
    },
  },
});
