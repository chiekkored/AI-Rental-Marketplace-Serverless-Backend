const { BOOKING_STATUS } = require("./booking.util");

function countPendingBookings(bookings) {
  return bookings.filter((booking) => booking?.status === BOOKING_STATUS.pending).length;
}

function pendingBookingCountIncrementValue({ fieldValue, currentValue, delta }) {
  if (fieldValue && typeof fieldValue.increment === "function") {
    return fieldValue.increment(delta);
  }

  const base = typeof currentValue === "number" && Number.isFinite(currentValue) ? currentValue : 0;
  return base + delta;
}

module.exports = {
  countPendingBookings,
  pendingBookingCountIncrementValue,
};
