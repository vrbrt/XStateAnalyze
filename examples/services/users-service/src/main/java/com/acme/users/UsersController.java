package com.acme.users;

import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/users")
public class UsersController {
  private final UserService userService;
  private final OrdersClient ordersClient;

  public UsersController(UserService userService, OrdersClient ordersClient) {
    this.userService = userService;
    this.ordersClient = ordersClient;
  }

  @GetMapping
  public List<UserDto> listUsers() {
    return userService.findAll();
  }

  @GetMapping("/{id}")
  public UserDto getUserById(@PathVariable Long id) {
    UserDto user = userService.findById(id).orElseThrow();
    user.setOrderCount(ordersClient.countOrders(id));
    return user;
  }

  @PostMapping
  public UserDto createUser(@RequestBody UserDto dto) {
    return userService.create(dto);
  }

  @DeleteMapping("/{id}")
  public void deleteUser(@PathVariable Long id) {
    userService.delete(id);
  }
}
