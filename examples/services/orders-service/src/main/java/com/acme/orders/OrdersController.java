package com.acme.orders;

import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/api/orders")
public class OrdersController {
  private final OrderService orderService;

  public OrdersController(OrderService orderService) { this.orderService = orderService; }

  @GetMapping
  public List<Order> listOrdersForUser(@RequestParam("user") Long userId) {
    return orderService.forUser(userId);
  }

  @GetMapping("/{id}")
  public Order getOrder(@PathVariable String id) {
    return orderService.get(id);
  }

  @PostMapping
  public Order placeOrder(@RequestBody Order order) {
    return orderService.place(order);
  }
}
