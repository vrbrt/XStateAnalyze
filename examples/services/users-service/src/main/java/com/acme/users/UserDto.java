package com.acme.users;

public class UserDto {
  private Long id;
  private String name;
  private String email;
  private int orderCount;
  public Long getId() { return id; }
  public String getName() { return name; }
  public String getEmail() { return email; }
  public void setOrderCount(int c) { this.orderCount = c; }
}
