export function calculateTotal(items) {
  return items.reduce((total, item) => total + item.price * item.qty, 0)
}
